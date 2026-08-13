# Release provenance contract

`desktop/scripts/assemble-release.sh` creates `RELEASE-PROVENANCE.json` only after
the exact-source, Actions-artifact, local macOS build, signature, entitlement, and DMG
checks pass. The file is public release evidence, not a credential or a substitute
for human acceptance.

The JSON uses `schemaVersion: 1` and contains these stable top-level objects:

- `release`: `tag`, `version`, UTC assembly timestamp, and assembler path;
- `source`: the actual repository name and numeric GitHub repository ID that produced
  the workflow evidence, trusted branch, and exact 40-character commit SHA;
- `builds.macos`: local build method, `ad-hoc` signing, `notarized: false`,
  `hardenedRuntime: true`, UTC build time, Node/npm/electron-builder versions, macOS
  product/build versions, builder architecture, and the selected Xcode or Command
  Line Tools version, directory, SDK, Apple clang version, and `codesign` path;
- `builds.windows` and `builds.linux`: the actual workflow repository and numeric ID,
  GitHub Actions run ID, run attempt, artifact ID, source-SHA-qualified artifact
  name, UTC build time, Node/npm/electron-builder versions, and stable hosted-runner
  environment, OS, architecture, and requested label;
- `evidence`: SHA-256 values for each saved run JSON, artifact JSON, and artifact ZIP,
  plus the matching `sha256:...` digest asserted by the GitHub artifact API;
- `assets`: target architecture, byte length, and lowercase SHA-256 for each of the four
  stable installers; and
- `verification`: the strict macOS commands and the source-bound artifact assertion.

The assembler has no GitHub client or network step. A separate read phase fetches the
evidence files, and the assembler requires for both Windows and Linux:

1. a completed, successful `workflow_dispatch` run of
   `.github/workflows/release.yml`;
2. run `head_sha` equal to the requested source commit, `head_branch` equal to the
   explicitly allowed `release/1.0` or `main` branch, and `repository.full_name`
   equal to the separately supplied actual source/workflow repository, with both
   `repository` and `head_repository` names and numeric IDs equal;
3. an unexpired, nonempty artifact whose numeric ID belongs to that run and SHA,
   whose required workflow repository IDs match the run JSON, and whose API
   `size_in_bytes` equals the supplied ZIP byte length and API `digest` exactly
   equals the supplied ZIP's computed `sha256:...` digest;
4. the exact artifact name `installer-<platform>-<source-sha>`; and
5. an embedded `BUILD-METADATA.json` with matching schema, actual source/workflow
   repository name and ID, source SHA, version, platform, x64 target architecture,
   workflow run ID, run attempt, actual installer byte length and SHA-256, a real
   second-precision UTC build time, Node 22, npm 10.9.9, the exact locked
   electron-builder version, and the expected GitHub-hosted runner attributes; and
6. for Windows, the separately uploaded unpacked app payload whose actual byte
   length, SHA-256, and AMD64 (`0x8664`) PE machine match metadata, plus the expected
   i386 (`0x014c`) PE32 NSIS installer wrapper. The locked, platform-resolved
   `7zip-bin` also tests the NSIS archive, extracts its embedded `DesmosLock.exe` to
   prove AMD64 directly, and requires embedded `resources/app.asar` to byte-match the
   separately uploaded unpacked archive. The two application EXEs are not required
   to hash identically because their PE resources can legitimately differ.

The local Mac builder parses the checkout's uncredentialed GitHub `origin`, requires
it to equal the explicit actual source repository, and requires the fetched trusted
branch head to equal the source SHA. It emits `MACOS-BUILD-METADATA.json` with that
source identity, validated UTC timestamp, exact locked electron-builder version,
Node 22 and exact npm 10.9.9 versions, macOS product/build and architecture evidence,
and selected Xcode/Command Line Tools, SDK, Apple clang, and `/usr/bin/codesign`
paths. Apple's
OS-supplied `codesign` has no supported version flag, so the OS build and exact path
bind that tool without inventing a version. The metadata also records the
`arm64+x64` target, signing/notarization flags, and both DMG hashes and sizes. Offline
assembly validates and carries these exact fields forward and reruns the strict DMG
verifier.

The npm runtime is not ambient: `desktop/package.json` pins npm 10.9.9 and its
SHA-512 package hash, and the Mac builder resolves it through Corepack in an
ephemeral cache without enabling shims or making a global installation. Structural
DMG verification is not Gatekeeper acceptance. Private per-host receipts bind a
Mac Mini Safari ARM64/native test and separate MacBook Safari ARM64/native plus
Chrome x64/Rosetta tests to this source and all six asset hashes. Dialog and launch
fields are witnessed operator attestations. The recorder validates its selected role
against the local Mac mini or MacBook hardware family; each receipt stores only that
generic family plus a hashed stable hardware fingerprint. The private aggregate
receipt requires distinct fingerprints, exact roles/scopes, and identical source,
tag, manifest, asset hashes, and normalized saved GitHub draft evidence. That evidence
binds the numeric draft release and all six asset IDs, sizes, GitHub SHA-256 digests,
and credential-free `untagged-*` browser URLs before publication. Canonical v1.0.1
URLs are verified anonymously after publication. None of these private receipts or
the saved draft response is one of the six public assets.

GitHub does not expose the resolved `*-latest` runner image version as a stable
workflow context; it appears only in setup logs. Provenance therefore records the
reliable `github-hosted` environment, runner OS/architecture, and requested label,
without claiming a brittle image identifier.

`source.repository` is never a future alias. Before transfer it must be
`danielholguin31/desmoslock`; after a completed transfer the operator must explicitly
update the checkout origin and dispatch input to `desmoslock/desmoslock`. A transfer
or repository-name change during a candidate cycle invalidates the evidence and
requires a new build and assembly, even though GitHub may redirect the old remote
URL.

The release checksum manifest covers `RELEASE-PROVENANCE.json` in addition to every
installer. The manifest cannot cover itself. Its exact ordered entries are:

```text
DesmosLock-mac.dmg
DesmosLock-mac-intel.dmg
DesmosLock-setup.exe
DesmosLock.AppImage
RELEASE-PROVENANCE.json
```

The final release asset set adds `SHA256SUMS.txt`, for exactly six files total. Reject
missing, extra, renamed, overwritten, expired, or source-mismatched inputs. A changed
installer, provenance document, source commit, run, or artifact requires a new full
assembly and acceptance cycle.
