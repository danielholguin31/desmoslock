# Retained unsigned desktop artifact collector

`scripts/collect-unsigned-desktop.mjs` creates one native-architecture
DesmosLock Internal app and a checkpoint of observed source and artifact evidence.
It does not launch Electron or DesmosLock, perform AAC or Keychain actions, install
anything, download dependencies, or grant release acceptance.

The pinned Darwin packager applies local ad-hoc signing even with `osxSign:false`;
arm64 fuse hardening also repairs the ad-hoc signature. Evidence and command
receipts therefore report `signing: "ad-hoc-only"`. The existing “unsigned” command
name refers to the absence of a Developer ID distribution identity. Local ad-hoc
sealing uses no Developer ID identity or Keychain, requests no notarization, and
establishes no distribution trust. This evidence label does not change packaging
or signing behavior.

The command is intended for a coordinated build window in a dedicated, positive
source checkout. Its current source tests use synthetic files and mocked
build/package/storage operations. Passing those tests is not evidence that an
actual candidate was built or that the native checkpoint helper ran.

## Prerequisites

- The checkout's `HEAD` and local `refs/remotes/origin/main` must both equal the
  reviewed canonical commit in the descriptor. Its tree must match exactly. The
  collector does not fetch Git refs or verify GitHub CI status. A supplied CI run
  URL is a reference, not independent proof of review or a successful CI run.
- Use the selected Node 24.20.0 executable on macOS with the target native
  architecture (`arm64` or `x64`). Schema 1 does not describe universal builds.
  The explicit npm CLI, compiler, SDK, Node headers, official Electron ZIP and
  prepared dependency provider must already exist. No installation or download
  fallback exists.
- Prepare `packages/domain/dist`, `packages/contracts/dist`, and
  `packages/test-support/dist` through the repository's existing package builds
  in the coordinated output window. The collector imports the shared compiled
  identity parser and existing build helpers; it has no hidden bootstrap copy.
  It subsequently repeats the three fixed TypeScript package builds and the
  existing desktop builder after input verification.
- Prepare an independently reviewed copy of the unchanged accepted storage
  helper at `artifacts/unsigned-artifact-tools/durable-record.node`, outside
  build-cleaned desktop output. Its descriptor SHA256 must match. The collector
  never copies a freshly built product helper into that prerequisite location.
- `artifacts` must be an existing real owned directory. The input directory
  `artifacts/unsigned-artifact-inputs` must be owned and mode `0700`; create its
  regular, nonlinked `<run-uuid>.json` descriptor before invoking the command.
  The collector creates private run, checkpoint, evidence and temporary
  directories. Do not run another build against the checkout during collection.

The collector's explicit environment contains the public backend values and
selected native paths. It does not inherit process environment values. npm's
version check uses global mode with two distinct empty configuration files in
the owned run directory, offline mode, and an owned cache path. It does not read
the user's npm configuration as part of that check.

## Descriptor contract

The JSON descriptor has exactly these fields. Extra fields, arbitrary commands,
duplicate manifest entries and undeclared execution file paths are rejected.
Use measured values; do not fill hashes with placeholders.

| Field                | Value                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`      | `1`                                                                                                                                                                                                                                  |
| `inputs`             | Exact shared `ClientBuildInputs` from `packages/contracts/src/build-identity.ts`                                                                                                                                                     |
| `review`             | Exactly `sourceCommit`, `mainRef`, `ciCommit`, `ciUrl`; both commits equal `inputs.sourceCommit`, ref is `refs/remotes/origin/main`, URL is `https://github.com/danielholguin31/desmoslock/actions/runs/<decimal-id>`                |
| `publicBackend`      | Exactly `environment` (`local` or `staging`) and `url`, accepted by the existing public backend parser                                                                                                                               |
| `sourceManifest`     | Sorted exact positive source rows: `{path,mode,gitBlob,sha256,bytes}`; mode `100644` or `100755`, Git blob SHA1, measured SHA256 and byte length                                                                                     |
| `paths`              | Exactly absolute normalized `node`, `npm`, `compiler`, `sdk`, `nodeHeaders`, `electronZipDirectory`, `dependencies`; Node ends `/bin/node`, npm ends `/bin/npm-cli.js`, dependencies names the prepared real `node_modules` provider |
| `dependencies`       | Every installed third-party package, as `{name,version,packageJsonSha256,integrity}`; `integrity` is the matching package-lock SHA512 SRI string                                                                                     |
| `executionFiles`     | Exactly the four positive provider-relative file measurements below, each `{path,sha256,bytes}`                                                                                                                                      |
| `nativeHelperSha256` | SHA256 of the separately prepared fixed checkpoint helper                                                                                                                                                                            |

The execution file set is `typescript/bin/tsc`, `typescript/lib/_tsc.js`,
`esbuild/lib/main.js`, and `@esbuild/darwin-<architecture>/bin/esbuild`.
Dependency inspection reads those files and each explicitly declared package's
`package.json`. It verifies installed links resolve inside the declared provider,
compares package names/versions and lock integrity strings, and verifies the five
workspace package links resolve to this checkout. It does not recursively walk
third-party package trees or independently check npm tarball bytes against SRI.
Private dependency names and scope components are rejected before a scope is
listed or package metadata is read. Scope links must resolve within this
checkout's prepared module directory or its declared provider.

The positive source set is fixed in the collector, not chosen by the descriptor:

- All regular files under `apps/desktop/src`, `apps/desktop/native`, and
  `packages/{domain,contracts,test-support}/src`.
- Root `package.json`, `package-lock.json`, and `tsconfig.base.json`; desktop
  package/TypeScript metadata; package/TypeScript/build metadata for the three
  shared packages.
- The collector, checkpoint and artifact helpers, existing desktop builder,
  both native builder scripts, and existing Electron fuse policy.

The manifest must equal that set in the selected Git tree and the working
checkout, including bytes and executable modes, before and after the build.
Missing, additional or changed positive inputs fail. Paths outside that set are
not read as source evidence. Any `.env*` component, traversal, credential/private
path, symlink or hardlink is rejected before its contents are read or hashed.
Other tracked files, including docs/CI and excluded legacy/private paths, are
represented by commit/tree metadata only; the collector makes no claim that all
tracked bytes were verified.

`inputs.tools.nodeHeadersSha256` is SHA256 over compact JSON of a deterministic
depth-first, name-sorted list of header-root file rows
`{path,mode,sha256,bytes}`. Only regular `.h`/`.gypi` files are accepted; links,
private names and unexpected file types fail. SDK evidence measures only the
explicit `SDKSettings.json` bytes/version and the fixed
`System/Library/CoreServices/SystemVersion.plist` bytes/version/build, not the
entire SDK. Two fixed read-only `plutil -extract` calls read the plist's
`ProductVersion` and `ProductBuildVersion`; its hash is retained as external
evidence. Tool versions are observed through fixed Node/npm/compiler version commands;
their executable/CLI hashes must match the descriptor.

`buildId` is SHA256 of the shared canonical input serialization: recursively
ASCII-sorted object keys, compact JSON, UTF-8, without a trailing newline. The
backend digest hashes compact `{environment,url}` in that fixed field order.
Build outputs embed `ClientBuildIdentity` in the main-private compile definition
and `dist/build-identity.json`. Ordinary builds have null identity. This is client
provenance and gives no admission, native, signing or platform authority. Final
artifact hashes are measured externally and are not self-embedded.

## Commands and retained output

After the prerequisites and coordinated output window are established:

```sh
<selected-node> scripts/collect-unsigned-desktop.mjs create --run-id <uuid-v4> --inputs <checkout>/artifacts/unsigned-artifact-inputs/<uuid-v4>.json
<selected-node> scripts/collect-unsigned-desktop.mjs resume --run-id <uuid-v4>
```

The command accepts no other operations or flags. The only build commands are
the selected Node executable running TypeScript `-p` for domain, contracts and
test-support, in that order, then the existing `build-app.mjs desktop
--production --candidate-inputs <owned-run>/build-inputs.json`. Both native
builders and packaging/fuse handling remain the existing implementations. There
is no app launch or physical test command.

The retained run is `artifacts/unsigned-artifact-runs/<uuid>/`:

- `candidate/DesmosLock Internal.app`: final app, relocated from the packager's
  completed directory before inspection/checkpoint publication.
- `descriptor.json` and `build-inputs.json`: validated descriptor and canonical
  inputs; descriptor digest is bound to source evidence and checked on resume.
- `evidence/<sha256>`: bounded content-addressed observations, revalidated against
  their recorded digest/length when loading and before completion.
- `checkpoint/`: the separate accepted helper's fixed private record/lock files.
- `temporary/`: owned empty npm configurations and distinct package attempt
  roots. Partial output is retained on failure.

The artifact helper owns the exact distribution, ASAR/unpacked/native inventory,
Mach-O checks, app-tree hash and observed disabled fuses. The collector reuses
that helper and retains its actual output measurements. Checkpoint cases are
limited to `source-inputs`, `distribution-inventory`, `packaged-inventory`,
`packaged-fuses`, `native-inventory`, and `checkpoint-readback`. A returned failed
observation stops dependent work; it cannot be treated as a successful callback.

## Resume and interrupted work

Create holds an exclusive checkout build lease at
`artifacts/unsigned-artifact-collector.lock` through settlement and storage close.
It never steals a lease, uses PID liveness to delete one, or unlocks while owned
work is draining. The lease may remain after process death.
A timeout, output limit, thrown error or failed checkpoint result after entering
build or packaging conservatively retains the lease: a settled direct-child
promise does not prove its compiler/packager descendants stopped. A failed final
storage close also fails the command instead of returning a success receipt.
An entered build/package operation that throws marks output settlement uncertain
in the storage scope. The current handle retains its owner, leaves the durable
case pending, refuses further operations/recovery, and cannot report a successful
close. The CLI reports that uncertainty explicitly. A later process cannot use
checkpoint reopening alone to justify resuming output mutation.

Resume is intentionally limited to a fully published, checkpoint-bound candidate
whose latest packaging attempt completed successfully. It acquires the unchanged
native per-run lock, performs the helper's recovery/barrier and sidecar checks,
checks the retained descriptor and artifact, and appends observations. It never
builds, packages or changes fuses. A matching retained build lease may remain in
place during this path and is left untouched. A lease for a different run fails.

If interrupted work has no bound candidate or has an unfinished packaging
attempt, resume stops and preserves incomplete evidence. A fresh isolated
checkout with reverified inputs is the practical recovery path; restarting the
same output mutation would not prove that an orphaned packager had stopped.
Missing or changed artifact/evidence bytes invalidate prior observations. A
missing checkpoint is not initialized as a successful resume. The helper stops
on publication uncertainty and requires successful replacement-barrier recovery;
readback alone does not heal an uncertain write.

The checkpoint retains at most 64 attempts and 60 KiB of serialized state. It
stops at capacity without pruning. The claim is **durable checkpoint with
revalidated external evidence**. The native checkpoint flush/rename/parent-flush
guarantee does not extend power-loss durability to the app or Node-written
sidecars.

## Acceptance boundary

All physical cases remain pending: universal execution; Developer ID,
notarization, stapling and Gatekeeper; install/uninstall/rollback; two clean Macs;
synthetic staff/Test/Student and tenancy journeys; acknowledged event visibility;
AAC categories; backend/network loss; crash/reboot/corruption; display/prohibited
app changes; emergency/Teacher release/Test end; calculator attacks; and protected
graphing. The CLI cannot promote those entries.

The selected graphing profile is `internal-graphing-v1`. Its separately owned
finite oracle in `tests/e2e/electron/support/calculator-graph-oracle.ts` supports
source-level checks; screenshots, SVG or PNG source evidence do not establish
protected packaged graphing. Backend expectation remains `internal-baseline-v2`,
schema 4. Neither a UUID nor an unsigned app establishes a distinct clean Mac or
release acceptance.
