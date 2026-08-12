# Release provenance contract

`desktop/scripts/assemble-release.sh` creates `RELEASE-PROVENANCE.json` only after
the exact-source, Actions-artifact, local macOS build, signature, entitlement, and DMG
checks pass. The file is public release evidence, not a credential or a substitute
for human acceptance.

The JSON uses `schemaVersion: 1` and contains these stable top-level objects:

- `release`: `tag`, `version`, UTC assembly timestamp, and assembler path;
- `source`: the canonical `desmoslock/desmoslock` repository, trusted branch, and
  exact 40-character commit SHA;
- `builds.macos`: local build method, `ad-hoc` signing, `notarized: false`,
  `hardenedRuntime: true`, and Node/npm/electron-builder versions;
- `builds.windows` and `builds.linux`: the actual workflow repository, GitHub Actions
  run ID, run attempt, artifact ID, and source-SHA-qualified artifact name;
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
   equal to the separately supplied actual workflow repository;
3. an unexpired, nonempty artifact whose numeric ID belongs to that run and SHA,
   whose present workflow repository IDs match the run JSON, and whose API
   `size_in_bytes` equals the supplied ZIP byte length and API `digest` exactly
   equals the supplied ZIP's computed `sha256:...` digest;
4. the exact artifact name `installer-<platform>-<source-sha>`; and
5. an embedded `BUILD-METADATA.json` with matching schema, canonical source
   repository, actual workflow repository, source SHA, version, platform, x64 target
   architecture, workflow run ID, run attempt, and actual installer byte length and
   SHA-256; and
6. for Windows, the separately uploaded unpacked app payload whose actual byte
   length, SHA-256, and AMD64 (`0x8664`) PE machine match metadata, plus the expected
   i386 (`0x014c`) PE32 NSIS installer wrapper. The locked, platform-resolved
   `7zip-bin` also tests the NSIS archive, extracts its embedded `DesmosLock.exe` to
   prove AMD64 directly, and requires embedded `resources/app.asar` to byte-match the
   separately uploaded unpacked archive. The two application EXEs are not required
   to hash identically because their PE resources can legitimately differ.

The local Mac builder emits `MACOS-BUILD-METADATA.json` with the same source identity,
validated UTC timestamp, tool-version formats, `arm64+x64` target, signing and
notarization flags, and hashes and sizes for both versioned DMGs. Offline assembly
recomputes those values and reruns the strict DMG verifier.

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
