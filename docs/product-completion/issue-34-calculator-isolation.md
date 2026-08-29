# Issue 34 calculator-isolation boundary

Issue 34 is implemented for the internal pre-release line with an authorized,
repository-owned local graphing surface. The surface preserves the observable
expression, plot, removal, and zoom interactions needed to verify containment without
importing recovered code or acquiring third-party calculator content.

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

This is evidence of denial at Electron's pre-dispatch permission/window boundary, not
OS-level dispatch telemetry. Verification deliberately does not register a URL handler
or launch another application.

`npm run test:electron:production` is a containment and package-policy seam, not a
release path. It runs the hostile and relaunch assertions against an unpackaged
production build, then creates an unsigned package in a temporary directory. The
package has the `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, and
`EnableNodeCliInspectArguments` Electron fuses disabled. An external child-process
harness launches the exact executable without a diagnostic endpoint, verifies a
normal bounded launch, and requires `--inspect=0`, `--remote-debugging-port=0`, and
`--remote-debugging-pipe` to exit nonzero without advertising a debugger listener or
leaving a process alive. Every Electron launch receives a small explicit platform
environment rather than ambient parent variables. The seam removes the package and
performs no signing, notarization, publication, deployment, or legacy-v1 packaging.

This automated evidence does not claim physical black-box calculator interaction in
the package. That acceptance remains an issue 37 human/physical gate: XCUITest must
drive the exact `.app` or mounted-DMG application on a visible clean Mac using
OS-delivered clicks and typing, capture window screenshots, and prove visible plot
creation, zoom change, expression removal, and plot disappearance through screenshot
or pixel-delta receipts bound to the exact artifact. macOS Accessibility/Automation
and likely Screen Recording approval are required human gates; no shipped diagnostic
or test seam substitutes for them.
