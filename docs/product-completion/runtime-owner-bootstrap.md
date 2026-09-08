# Runtime initial Owner bootstrap

The canonical two-School fixture is immutable health evidence. Its six profiles stay unbound to Auth, and its Membership lifecycle fields stay at the pinned baseline. Operational staff accounts use separate rows with `seed_key IS NULL`.

The service-only `desmoslock_v2.internal_bind_initial_owner(workspace_id, profile_id, auth_user_id)` RPC keeps the same three UUID arguments and code-only result. Its forward migration accepts only a runtime School, runtime profile and active runtime Owner Membership, each with a null seed key. A pinned fixture component or a mixture of runtime and seeded components is rejected. The function still locks the target rows, verifies the confirmed Auth identity, rejects deleted or currently banned identities, preserves unique identity binding and the single bound active Owner rule, and records one audit event. An exact replay returns success without another mutation or audit event; it cannot reactivate an inactive Membership.

## Provisioning boundary

Provisioning is an explicit privileged database operation. The service role still has no direct table-insert grants, and there is no new public provisioning API. A reviewed operator plan uses the existing database administrator channel to create the runtime School, profile and active Owner Membership with null seed keys. It creates and binds that scaffold in one transaction, checks that the RPC returns exactly `initial_owner_bound`, and raises an error to roll back the entire transaction on any other result. The plan must use the intended, independently verified Auth user UUID and the reviewed School identity; it must not reuse the fixed synthetic fixture identifiers.

Before and after provisioning and binding, verify the real `internal_baseline_status()` result, the health dependency probe and the public `GET /functions/v1/health` response. The generation, exact migration-set hash, fixture version and fixture digest must match the current source contract, with `fixture_valid = true`. Repeat that check after invitation acceptance, recovery and revocation. A healthy result must come from the actual Auth/PostgREST dependencies; a mocked health response is not acceptance evidence.

The composed CI suite exercises this contract against a fresh disposable stack with synthetic GoTrue accounts and runtime rows. It keeps provider material in memory and does not enable browser traces or record passwords, tokens or TOTP secrets. Its append-only audit fixtures remain until the CI-owned disposable stack is stopped or reset.

## Existing installations

This forward migration does not silently repair a previously bound canonical fixture, remove seed keys, move accounts or rewrite the pinned baseline. Before any hosted rollout, inventory the exact schema, existing bootstrap protocol, current bindings and baseline validity. If a canonical fixture has been bound or otherwise changed, fail closed and prepare a separate reviewed reconciliation plan that preserves account and School ownership. The legacy recovery-RPC quiescence requirement in `auth-integration-evidence.md` also remains applicable to in-place upgrades.

An already approved empty synthetic target may be verified and reused. Creating another project is not a prerequisite when the existing target satisfies the reviewed requirements. Implementation, verification and evidence collection remain the agent's responsibility within the authorized scope; a human decision is needed only for an actual authority boundary or unresolved material choice. No hosted provisioning or migration is claimed by this source document.
