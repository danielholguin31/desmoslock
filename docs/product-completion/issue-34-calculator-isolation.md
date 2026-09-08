# Issue 34 calculator-isolation boundary

**Completion status: incomplete.** The selected synthetic internal Test profile,
`internal-graphing-v1`, uses the authorized repository-owned local graphing surface
permitted by [parent issue 28](https://github.com/danielholguin31/desmoslock/issues/28).
It has exactly seven forms: `y=x`, `y=x^2` (also `y=x²`), `y=sin(x)`, `y=cos(x)`,
numeric horizontal `y=n`, numeric vertical `x=n`, and numeric points `(x,y)`.
Multiple expressions, removal and bounded zoom belong to this profile. General
expressions such as `y=2x+1`, editing, panning, tables, sliders and inequalities
are not implemented. The profile is not full Desmos compatibility or a claim of
suitability for every intended Test.

Issue 34 remains open for externally observable normal graphing through real
Student admission and trusted Start in the exact protected packaged macOS
artifact. A synthetic isolation fixture does not establish that journey. No
third-party asset, credential or commercial approval is required to exercise
this repository-owned internal profile. Parent issue 28 defers commercial API
approval and product-name authorization to External Readiness.

The local surface is not the Desmos API and implies no permission to redistribute
or embed Desmos. If actual third-party content is selected, applicable terms and
embedding/redistribution permission for that specific use, its exact approved
asset or origin manifest, and any required credential-delivery model become
prerequisites. Internal acceptance is not an exemption from applicable terms.
The current assessment session denies every remote request; loading third-party
content cannot silently broaden that boundary.

Native protection and recovery belong to the separate
[native assessment contract](native-assessment-protection.md). The trusted shell
exposes named, revision-bound admission, Start and reviewed Emergency actions;
the calculator has no preload or privileged bridge. The legacy lock request
remains denied. Production main keeps the calculator detached until the matching
native `did_begin`, a causally later accepted backend read, durable locked state
and all five current categories authorize attachment. The non-shipped isolation
fixture explicitly attaches a calculator for containment testing without Student
admission, native assessment or OS encryption. It cannot grant production Start.

The graphing fixture checks all seven profile forms against finite SVG geometry
at known visible coordinates in the `720 × 460` viewBox. It captures actual
calculator pixels around non-overlapping quadratic samples before and after
zoom, and around a new point after the hostile probe. Paint must contain the
expected opaque plot color; path counts, labels and PNG byte length alone are
insufficient. A real blank white PNG exceeding the old 1,000-byte threshold is
explicitly rejected by the paint oracle. Pure controls also reject empty,
degenerate, nonfinite, displaced, hidden/offscreen and unchanged zoom geometry.

The deterministic synthetic sequence is: retain initial `y=x`; add `y=x^2` at
100%; zoom once to 125%; add `y=sin(x)`, `y=cos(x)`, `y=3`, `x=-3`, `(2,3)`;
remove only `y=x^2` and compare every surviving geometry; submit unsupported
`y=2x+1` and require the error with unchanged plots/zoom; run the existing hostile
containment probe with all six remaining forms and 125% zoom verified first.
The probe attempts a foreign main-frame navigation. Production restores its own
calculator document after that load fails; the document's temporary graph state
starts again at `y=x` and 100% zoom. The fixture requires the actual failed foreign
main-frame load, subsequent owned document navigation and completed load, and a
fresh document time origin. It rejects unexplained state loss or wrong restored
geometry. It then adds `(4,-2)` through native input and requires its visible
point at the 100% position/color, with the restored baseline unchanged. Bridge,
URL, window and zero HTTP/TCP/UDP sink checks remain independent requirements. The pure controls and fixture source do not themselves
claim an executed Electron or packaged graphing pass.

Both the trusted shell's default Electron session and the calculator's ephemeral
session deny permissions, downloads, device selection, display capture, popups, and
external protocols by default. Production ships no denial-observer registry and does
not import or call Electron's `shell.openExternal`. A non-shipped Electron fixture
instruments permission-handler construction and confirms that the exact
`openExternal` permission request receives `false` before isolated test observers run;
an observer failure cannot change that already-delivered denial. The non-shipped
Playwright isolation harness separately requires the external `window.open` call to
return no window and the calculator URL and BrowserWindow count to remain unchanged.
That harness exercises the unpackaged production build; it uses Electron's internal
automation channel and is not black-box package or release acceptance. Production
assets must contain no external-dispatch call, diagnostic registry, or test API.

Calculator teardown immediately detaches the surface and requests closure. It
retains the owned WebContents until actual destruction acknowledgment, then
independently attempts policy/protocol removal and storage, cache, authentication
and connection cleanup. A closure request is not destruction proof. Repeated
callers observe one cached result; cleanup failures remain aggregated. A
parent-driven failure reaches the lifecycle supervisor, and startup preserves
its primary failure alongside teardown failures. These ownership guarantees are
covered by the separate native/surface source and runtime gates.

Required Linux CI uses an explicitly non-release compatibility profile with Chromium's
OS/process sandbox disabled by `--no-sandbox`, `--disable-setuid-sandbox`, Playwright's
`chromiumSandbox: false`, and `ELECTRON_DISABLE_SANDBOX=1`. Reading
`getLastWebPreferences().sandbox` proves only that production code requested Electron's
per-WebContents sandbox preference. It does not attest an active Chromium or OS sandbox.
The renderer-preference, context-isolation, Node-exclusion, session-policy, and process-
supervision checks remain valid within that narrower boundary.

This is evidence of denial at Electron's pre-dispatch permission/window boundary, not
OS-level dispatch telemetry. Verification deliberately does not register a URL handler
or launch another application.

`npm run test:electron:production` is a containment and package-policy seam, not a
release path. It runs the hostile and relaunch assertions against an unpackaged
production build, then creates an unsigned package in a temporary directory. The
package has the `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, and
`EnableNodeCliInspectArguments` Electron fuses disabled. An external child-process
harness launches the exact executable as a non-detached child of a dedicated detached
sentinel. The sentinel remains the session and process-group leader after the executable
exits; the verifier parent never stores a signal capability for, probes, or signals a
numeric process-group ID. The sentinel attests a persistent TERM-resistant canary,
records the executable's observed descendants and its current same-group identities,
arms an unconditional self-inclusive `SIGKILL`, and signals only its own current group
with `kill(0, ...)`. The parent accepts retirement only after the sentinel closes by that
`SIGKILL`, both target output pipes reach EOF, and every recorded PID/start-time identity
has disappeared. A retired or lost capability makes no later process-group system call,
so numeric ID reuse cannot redirect cleanup to an unrelated group.

The harness verifies a normal bounded launch and requires `--inspect=0`,
`--remote-debugging-port=0`, and `--remote-debugging-pipe` to exit with policy status 78.
On macOS, it launches the executable inside the exact generated `.app` and requires every
prohibited sandbox-weakening or process-inlining switch—including `--no-sandbox`,
`--disable-gpu-sandbox`, `--disable-setuid-sandbox`, `--single-process`,
`--in-process-gpu`, and the remaining enumerated policy controls—to exit with status 78.
The rejection receipt is emitted by the real packaged main process and binds the result
to its observed `app.isPackaged`, `process.argv`, and `app.commandLine` state; helper-only
policy tests do not satisfy this seam. The exact packaged app also rejects an otherwise
sanitized launch that injects `ELECTRON_DISABLE_SANDBOX=1`. Each hostile launch must exit
before opening a window. The ordinary macOS package launch receives neither those
switches nor the sandbox-disabling environment control. No launch may advertise a
debugger listener or leave a same-group or recorded helper alive. Every Electron launch
receives a small explicit platform environment rather than ambient parent variables. The
seam removes the unsigned package and performs no signing, notarization, publication,
deployment, or legacy-v1 packaging.

This retirement proof covers the original process group and exact PID/start-time
identities observed before termination on the host where the seam runs. Its success
receipt is named `recordedProcessIdentitiesGone`, and the one-way handle state is
`isRetired`; neither claims that an arbitrary process tree is empty. An immediate parent
can create a `setsid` child, close inherited output pipes, and exit before the polling
sentinel observes that child. The regression suite demonstrates that exact limitation
and requires the receipt not to expose `treeEmpty`. A surviving recorded descendant that
has already used `setsid` still makes verification fail closed because the sentinel's
group signal cannot remove it. Required CI currently runs only the unsandboxed Linux
compatibility profile; it produces neither a macOS package receipt nor an active-
Chromium-sandbox attestation. Windows execution fails closed until an atomic Job Object
adapter can provide scoped containment; it does not fall back to leader-only termination.

This automated evidence does not complete issue 34 and does not claim physical black-box
calculator interaction in the package. Exact packaged, externally observable graphing
acceptance remains a human/physical gate (tracked with issue 37): a locally present
operator, or a separately verified OS-input runner, must drive the exact
signed/notarized `.app` or mounted-DMG application on a visible clean Mac using
OS-delivered clicks and typing and prove visible plot
creation, zoom change, intended removal preserving another plot, unsupported-input
rejection and continued graphing after the hostile probe through observations
bound to the exact artifact. Enter through actual admission and trusted Start;
observe graph withdrawal on negative authority/end/recovery. For the navigation
subcase, observe recovery to the initial `y=x` at 100%, then add visible `(4,-2)`
while preserving that restored baseline; do not require the former six forms at
125% to survive the document reset. If no approved exact-package method can drive
the hostile subcase without injection or weakened protection, keep it pending.
The fixture's direct attachment and injected JavaScript do not qualify.

For protected portions, use external-camera photos or footage with a locally
present operator's account of the action and visible outcome. Bind each original
capture's path, byte count and SHA-256 to the case/run ID, host and architecture,
OS version, exact app/DMG hash and build identity, synthetic School/Test/StudentSession
and epoch, and observation time. Do not capture real personal data or secrets.
This is witnessed camera evidence, not an OS screenshot, native attestation or
automated pixel-oracle result. Keep pre/post app screenshots only where permitted.
AAC screenshot blocking must remain intact: Screen Recording approval does not
make protected screenshots an acceptance requirement or authorize an exception.
Use only the Accessibility/Automation or capture permissions required by the
selected operator path; its ability to deliver input under AAC must be verified
without relaxing protection. No shipped diagnostic or test seam substitutes for
physical observations. The clean-Mac launch must use no sandbox-disabling control,
but its UI receipt remains separate from an active Chromium-sandbox attestation.
Until that protected exact-artifact receipt exists, every issue 34 completion
record must report the packaged journey as unmet. Third-party rights/assets
remain conditional on using third-party content; no issue closure follows from
the finite profile or its synthetic regression.
