# Universal unsigned artifact preparation

`scripts/collect-universal-desktop.mjs` prepares one macOS app containing arm64
and x64 slices. It builds the common JavaScript and static assets once, compiles
the two fixed native addons for each target, and uses the installed public
Electron packager universal path with `mergeASARs: true`. It does not run the app.
Local packaging applies ad-hoc signatures; Developer ID signing, notarization,
Gatekeeper acceptance, and physical Mac observations remain incomplete.

The existing native collector, descriptor grammar, build identity schema, and
checkpoint kind remain supported. The universal collector has its own input
grammar and checkpoint kind; neither opener converts the other's records.
Both share the checkout build lease and the same fixed durable-record helper.

## Inputs and identity

Prepare a new isolated checkout from the exact reviewed main commit after its
required CI succeeds. Resolve every build-relevant positive source path against
that commit and tree, without materializing excluded `.env*` or private files.
The collector compares positive file bytes, mode, and Git blob identity, the
package lock, declared dependency metadata, four fixed compiler execution files,
Node/npm/compiler versions and hashes, SDK metadata, and the full positive Node
header inventory. It compares the supplied CI reference to the selected commit;
it does not contact GitHub or claim to independently verify CI or human review.

The nine descriptor keys are `schemaVersion`, `inputs`, `review`,
`publicBackend`, `sourceManifest`, `paths`, `dependencies`, `executionFiles`,
and `nativeHelperSha256`. `inputs` is the exact `ClientUniversalBuildInputs`
grammar. `paths` retains the native descriptor's seven explicit paths and adds
the exact `lipo` and `codesign` executable paths. The Electron archive directory
must contain both selected official Electron 43.4.1 Darwin ZIPs; the collector
does not download them. Each ZIP must match the installed checksum metadata and
its architecture-specific input hash.

The common identity keeps the existing six `ClientBuildIdentity` fields. Its
`buildId` is SHA-256 of the UTF-8 prefix `desmoslock:universal-build:v1`, one NUL
byte, and recursively ASCII-key-sorted compact JSON inputs with no newline.
Inputs bind both archive hashes, each architecture, N-API 8, macOS deployment
target 13.0, packager/universal/fuses versions, lipo/codesign hashes, and the
fixed composition policy. No output digest, run path, signature, or timestamp
is embedded into itself. The common main bundle gets this identity; the
renderer and calculator receive no identity proof or native capability.

## Owned execution

The only public commands are `create --run-id <UUIDv4> --inputs <descriptor>`
and `resume --run-id <UUIDv4>`. The descriptor must already exist at
`artifacts/universal-artifact-inputs/<UUIDv4>.json`; no placeholder commit,
tree, CI URL, or tool hash is a valid execution input. The run lives at
`artifacts/universal-artifact-runs/<UUIDv4>` with:

- `common/`: one common build, initially empty and private.
- `slices/arm64/native/` and `slices/x64/native/`: disjoint compiler outputs.
- `temporary/`: bounded build, comparison, and packager scratch.
- `candidate/`: the atomically renamed final package directory.
- `checkpoint/` and `evidence/`: durable checkpoint and directly hashed sidecars.

The fixed helper is `artifacts/unsigned-artifact-tools/durable-record.node`.
The checkout lease is `artifacts/unsigned-artifact-collector.lock`, shared with
the native collector. Every mutating operation follows a persisted pending
attempt. Child commands use the selected Node and compiler, an explicit cleared
environment, local empty npm configuration, offline caches, and run-owned temp
paths. Packaging executes in a separate fixed Node child so the universal
library's use of `os.tmpdir()` stays within the run. Its PATH resolves lipo and
codesign through checked, owned links to the pinned executables. A surrounding
reviewed process/write/network confinement policy remains an execution
prerequisite; this script does not claim to sandbox the operating system.

The native builders retain their ordinary defaults. The universal path instead
passes explicit architecture, output directory, compiler, SDK, and headers.
Each target output must be absent, and each ancestor is checked for ownership
and substitution. Common output ancestors are checked around every emit phase.
There is no cross-target execution, AAC operation, keychain access, or signing
account lookup in this preparation.

## Artifact and evidence checks

The packager uses exactly `asar: { unpack:
"{aac-protection,durable-record}.node" }`, with one final `app.asar` and the
two addons at `Contents/Resources/app.asar.unpacked/dist/native/`. Its default
package sanitizer removes staging-only `private`; the final package manifest
must have exactly `main`, `name`, `productName`, `type`, and `version`.

The inspector records both slices of every Mach-O, including framework,
helpers, executable and addons; checks all three required fuses and ASAR
integrity in each framework slice; and binds only the exact snapshot resource
names and bytes observed in the selected ZIPs. A broad `.bin` exception,
architecture dispatcher, missing or extra architecture, thin helper, changed
common asset, unexpected unpacked addon, or mismatched fuse fails closed.

Addon thin bytes are measured after public packaging and before whole-app
fuse/ad-hoc sealing. That historical measurement must match the original
compiler outputs and is retained inside the directly checkpoint-bound candidate
inventory. Final sealed bytes are measured separately; they can legitimately
differ. Resume supplies the retained pre-seal measurements and remeasures the
final tree, identity, source inputs, compiler outputs, archives, fuses, and
integrity. It never reconstructs historical bytes from a later sealed app.

The universal checkpoint uses schema 1, kind
`desmoslock-unsigned-universal-artifact-evidence`, and candidate kind
`unsigned-universal-app`. It preserves the existing six local case IDs, 14
ordered pending physical cases, 60 KiB checkpoint bound, 64-attempt bound,
32 direct evidence references per attempt, and 64 MiB sidecar bound. Sidecar
JSON does not imply recursive reference verification. Checkpoint syscall
success does not prove power-loss durability of the entire app or sidecar tree.

Resume accepts only a fully published, checkpoint-bound candidate with no
unfinished packaging. It performs no rebuild or repackaging and retains any
stale checkout lease. The final app stays unchanged; resume writes owned scratch
comparison files, readback evidence, and new checkpoint attempts. A failed or
timed-out mutating child leaves settlement
uncertain and the checkpoint pending; a failed final drain is not success.
Do not delete a lease based only on a PID or reopen a second helper to evade
ownership. Pre-candidate recovery uses a new isolated checkout after inputs
are reverified; retained partial outputs stay available for inspection.

## Incomplete release acceptance

Source and mocked tests do not establish a usable universal app, cross-CPU
execution, OS protection, encrypted storage, distribution trust, or physical
power-loss durability. The existing release tombstone remains authoritative.
Before a final distribution build, review the approved public app/helper bundle
identifiers and entitlement policy: the packager's current default Electron
identifiers do not automatically define the eventual signable candidate. Do
not silently change a frozen unsigned Info.plist during a later signing step.

Protected graphing remains `internal-graphing-v1`: start with `y=x`, add the
quadratic, zoom to 125%, add sine, cosine, `y=3`, `x=-3`, and `(2,3)`; remove only
the quadratic, reject `y=2x+1` without losing plots or zoom, perform the hostile
foreign main-frame failure probe, and observe recovery of the owned document
with a fresh default `y=x` plot at 100%. Then enter `(4,-2)` through actual input
and observe the red point. The pre-probe six plots and 125% zoom do not persist
across that document recovery. The exact packaged, protected two-Mac
journey must observe the same visible sequence through real admission and
Start. Prior-process recovery must remain detached and truthful; neither this
collector nor a client-reported evidence upload marks physical cases complete.
