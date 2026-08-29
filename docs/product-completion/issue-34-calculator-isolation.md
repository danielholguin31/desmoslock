# Issue 34 calculator-isolation boundary

Issue 34 is implemented for the synthetic internal-release line with an authorized,
repository-owned graphing fixture. The fixture preserves the observable expression,
plot, removal, and zoom interactions needed to verify containment without importing
recovered code or acquiring third-party calculator content.

The fixture is not the Desmos API and does not imply permission to redistribute or
embed Desmos. Replacing it with literal Desmos content remains an external human
gate: the project owner must provide documented API/embedding rights and the approved
credential-delivery model. That decision must also define the exact calculator asset
or origin manifest. The current assessment session intentionally denies every remote
request, and no agent should weaken that boundary merely to make third-party content
load.

Native device locking and recovery remain outside this slice and belong to issue 35.
The trusted preload exposes only a validated lock intent and a version read; the
synthetic handler records the intent without performing a device action.

`npm run test:electron:production` is a verification seam, not a release path. It
creates an unsigned package in a temporary directory, launches it twice against the
same application profile, proves that calculator state and browser storage do not
survive relaunch, and removes the package. It performs no signing, notarization,
publication, deployment, or legacy-v1 packaging.
