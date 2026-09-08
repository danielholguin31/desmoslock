# Native assessment protection

This internal source contract composes StudentSession admission with the macOS
assessment adapter. It does not establish actual macOS protection, OS encryption,
signing, packaged-device acceptance or release readiness. Exact-commit source,
build and runtime evidence belongs to the associated review and check records.

## Trusted Start and attachment

The renderer receives a closed composed admission/protection view and named,
revision-bearing Start and emergency-review actions. It receives no device key,
capability, native attempt ID, sequence, storage handle or arbitrary IPC method.
Joining a Test and opening the trusted shell do not start native assessment.

A trusted Start captures the current admission and shell generation. Main
requires all five categories: AAC, the owned emergency shortcut, application
status, durable persistence and the window/network boundary. Application policy
permits this app and the exact system Finder among registered regular apps; it
does not claim to enumerate every daemon or terminate other processes. The
application observer is installed before its snapshot and remains owned through
native cleanup. Support inspection alone never confirms AAC engagement.

Main prepares the calculator in a fresh nonpersistent denied-network session,
loads it while detached and durably records engaging before requesting native
begin. After an actual `did_begin`, it requires an accepted signed backend read
whose reserved read-start sequence is strictly later than the sequence captured
at that event. Equal monotonic timestamps cannot satisfy this causal fence.
Durable locked state, current issued admission, all local categories and the
native synchronous active predicate must still hold immediately before attach.
Late callbacks cannot revive a closed attempt.

The trusted toolbar reserves 96 CSS pixels. Main derives the calculator's
private offset as `ceil(96 * trustedWebContentsZoomFactor)`, bounded within the
actual content size. Owned page zoom actions invalidate protection before a
factor change. Page zoom remains available; visual/pinch zoom stays disabled.
The renderer cannot supply positive geometry proof. Actual native containment
under supported widths, large text and zoom requires rendered acceptance.

## Sustaining and ending an attempt

The existing 15-second Student maintenance pipeline is the only poller, including
when recovery owns a hidden window. Each accepted actual read supplies an
issuer-bound immutable receipt, valid only until the earlier capability deadline
or 30 seconds after that read started. Pending work never extends the deadline.
Renewal supplies a replacement receipt only after its durable successor and
follow-up state read succeed in the same writer.

During owned renewal, the old receipt may sustain only the same existing lock
through its original bounds. It cannot authorize a new Start, engaging/locked
commit or attachment after credential revision changes. Positive maintenance
does not append a per-poll journal fact, publish a transient busy state, reattach
content or start another read. Negative authority, uncertainty, expiry,
suspend/resume, display or trusted-window loss closes the local gate immediately.

Main detaches calculator content and requests its closure immediately, then
requests native end without waiting for destruction, disk or backend work.
Actual calculator destruction must be acknowledged before cleanup completion or
recovery presentation. Native begin/end
watchdogs can report uncertainty and retain ownership; they never fabricate a
delegate event. The exact active-attempt predicate is checked after awaits and
before attachment. A genuine terminal callback received while the single writer
is held is retained and later reconciled against its latest successor, without
overwriting an in-flight counter or operation.

Emergency abandonment uses a separate revision-bound review lane, including
during held preflight or an ordinary operation. Control+Alt+Shift+E opens that
review only. Confirmation closes the local gate first, records abandonment and
may forfeit only its captured still-current admission. It never promises server
receipt or native end when either result is unknown.

## Durable recovery

The encrypted version-2 record retains the existing admission and counter owner.
Exact version-1 decoding normalizes in memory without an implicit write. Native
facts occupy a bounded immutable journal of 32 slots, with eight reserved before
engaging; there is no pruning, upload acknowledgment or second record writer.
Unknown durability preserves possibly published bytes and blocks promotion.

Cleanup completion requires confirmed native quiescence, detached/destroyed
calculator content, owned window/shortcut restoration and durable completion.
An actual end remains distinct from the finite
`disposed_without_terminal_observation` disposition: the latter is allowed only
for this process's fresh attempt after a successful trusted disposal acknowledgment.
It preserves the original failure and records no invented native event or end.

A prior-process unfinished record remains detached recovery with new Start
disabled. Unreadable or unsupported original records also block targeted recovery
before quarantine, writes or egress, preserving uncertainty across quit/restart.
No operator reset is implemented here. An ownerless process may quit after
Student drain without clearing that barrier or claiming native end; an owned
unfinished native attempt retains its cleanup responsibility.

## Evidence boundaries

Synthetic tests cover the actual main/coordinator/store and decoder boundaries,
held reads and writes, three maintenance cycles and renewal, causal post-begin
reads, exact deadline closure, callback ordering, journal preservation, emergency
actions, cleanup uncertainty and trusted shell loss. Fake native events are not
platform acceptance. Compiling and loading an addon do not prove AAC behavior.

The build requires exactly the durable-record and AAC addons on macOS, including
their unpacked package paths and byte/architecture agreement. Other platforms
remain truthfully unavailable. Actual macOS AAC/KVO, shortcut ownership,
fullscreen/zoom containment, native end/restoration, restart and packaged-device
checks remain separate gates. The failed outer-Seatbelt macOS harness is preserved
as failed evidence; it supplies no renderer or native protection acceptance.
