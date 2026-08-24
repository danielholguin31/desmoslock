# Dependency and license policy

Ticket 03 applies this policy to the complete npm dependency graph, including build
and test tooling. Production packages remain private and may not add undeclared or
unlocked dependencies.

## Required checks

- `npm ci` must reproduce the root npm v3 lockfile without nested v2 lockfiles.
- Every registry package must have a cryptographic integrity value.
- `npm audit --audit-level=high` must report no critical or high advisory.
- The CycloneDX SBOM must be generated from the accepted root lockfile.
- Every external SBOM component must declare a license.
- AGPL, GPL, SSPL, BUSL, Commons Clause, and Elastic License dependencies are denied
  without explicit legal review and a separately accepted exception.

Permissive licenses such as MIT, ISC, Apache-2.0, BSD, BlueOak, CC0, and Unlicense
are accepted by the automated check. Weak-copyleft or custom licenses require human
review before a production dependency is added.

## Exception record

Any accepted exception must identify the exact package and version, whether it enters
a distributed artifact, advisory or license text, exploitability or obligation,
mitigation, owner, approval, expiry date, and removal or upgrade plan. An undocumented
allowlist entry is not an exception.
