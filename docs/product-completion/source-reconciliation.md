# v2 source reconciliation

## Status

Ticket 03 establishes a typed v2 workspace beside legacy v1. It does not publish v1.0.1, delete legacy evidence, or forward-port legacy implementation into a customer build.

The current friend-project development source remains `danielholguin31/desmoslock`. Production custody is a later gate.

## Audited source identities

- Paid prototype: `main@ea1d034aabf3798e52a6fdf99a666477e5dc7644`, tree `2465912d9686b83b4a3ea4c8c1df17272980516c`
- Recovery/release line: `release/1.0@ddcfce456f3cf015ab77d207310140a311c945ab`, tree `ab352dea9a5cdde409d2ff93d61dd62283005cbe`
- Existing draft v1.0.1: evidence only; it must remain unpublished

## Preserved executable evidence

`npm run test:evidence` extracts the exact audited files from commit `ddcfce456f3cf015ab77d207310140a311c945ab` into a temporary test-only directory and executes them without copying their implementation into v2 production source.

| Contract                                                                          | Audited tests | Source test                                  |
| --------------------------------------------------------------------------------- | ------------: | -------------------------------------------- |
| Lock recovery fails closed through unavailable or indeterminate restore           |             9 | `desktop/test/force-quit-recovery.test.js`   |
| Build and release provenance remains bound to exact source/tool identity          |            13 | `desktop/test/release-provenance.test.js`    |
| Gatekeeper receipts remain bound to exact draft assets and physical-host evidence |            15 | `desktop/test/gatekeeper-acceptance.test.js` |

The evidence harness verifies the audited tree before extracting files and fails if any suite count or pass count changes.

The same 37 behaviors are registered, with stable IDs, in
`tests/evidence/audited-release.contract.test.ts`. They remain explicit todos until
their v2 public seams exist; a passing legacy evidence run is not reported as a
passing v2 implementation.

## Forward-port rule

The legacy implementations used by these tests are not v2 implementations. Future tracer bullets must:

1. write or bind the corresponding v2 public-seam test first;
2. confirm the expected failure against the unimplemented v2 boundary;
3. port only the behavior still required by the accepted v2 contract;
4. keep `npm run test:evidence` green until the final source-reconciliation receipt explicitly supersedes each legacy test.

Recovery behavior maps to the main-process lock and secure-store boundaries. Provenance maps to the immutable v2 build/release receipt. Gatekeeper behavior remains evidence-only until signed v2 physical acceptance replaces the ad-hoc v1.0.1 contract.
