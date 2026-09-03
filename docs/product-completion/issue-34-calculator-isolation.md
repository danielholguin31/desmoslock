# Issue 34 calculator-isolation boundary

**Completion status: incomplete.** The repository implements and verifies the internal
pre-release containment boundary with an authorized, repository-owned local graphing
surface. Issue 34 must remain open until both external gates below are satisfied: the
owner supplies documented Desmos embedding/redistribution rights plus the exact approved
asset or origin manifest, and a human-bound receipt proves externally observable graphing
behavior in the exact packaged macOS artifact. The local surface preserves expression,
plot, removal, and zoom interactions for containment verification without importing
recovered code or acquiring third-party calculator content; it does not satisfy either
completion gate.

The local surface is not the Desmos API and does not imply permission to redistribute or
embed Desmos. Replacing it with literal Desmos content remains an external human
gate: the project owner must provide documented API/embedding rights and the approved
credential-delivery model. That decision must also define the exact calculator asset
or origin manifest. The current assessment session intentionally denies every remote
request, and no agent should weaken that boundary merely to make third-party content
load.

Native device locking and recovery remain outside this slice and belong to issue 35.
The trusted preload exposes only a validated assessment-lock request and a version
read. The production shell has no visible manual lock control; non-shipped Electron
verification invokes that fixed bridge method directly. The main-process handler
records the request without claiming or performing a native device action.

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

Calculator teardown closes the owned WebContents synchronously, then independently
attempts policy removal, protocol removal, and the storage, cache, authentication, and
connection cleanup operations. Repeated callers observe one cached result; every cleanup
failure is retained in an aggregate. A parent-driven cleanup failure is reported to the
desktop lifecycle supervisor, which fails closed instead of leaving an unobserved failed
session cleanup on macOS. Startup preserves its primary failure alongside any teardown
failures and still clears references and destroys the window.

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
acceptance remains a human/physical gate (tracked with issue 37): XCUITest must drive the
exact signed/notarized `.app` or mounted-DMG application on a visible clean Mac using
OS-delivered clicks and typing, capture window screenshots, and prove visible plot
creation, zoom change, expression removal, and plot disappearance through screenshot
or pixel-delta receipts bound to the exact artifact. macOS Accessibility/Automation
and likely Screen Recording approval are required human gates; no shipped diagnostic
or test seam substitutes for them. The clean-Mac launch must use no sandbox-disabling
control, but its UI receipt remains separate from an active Chromium-sandbox attestation.
Until that receipt and the Desmos rights/exact-asset decision both exist, every #34
completion receipt must report these as unmet gates.
