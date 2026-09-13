# StudentSession admission

This candidate adds accountless StudentSession admission to the internal v2
source contract: initial join, own-session maintenance, removal, targeted
re-admission and durable exact retries. This document records the selected
implementation and acceptance gates; it claims no new test, restored runtime,
hosted or packaged-device result.

## Authority and lifecycle

Active own-School Teachers, Admins and Owners operate a Test's StudentSessions
under existing live staff authority checks. Teachers use their verified provider
assurance; Admins and Owners require AAL2. Every code issuance, removal and
targeted re-admission requires review bound to the initiating account/provider
session, selected School/Test and expected revision. Codes are generated once
per private issuance intent and displayed only after confirmed issuance. An
unconfirmed result retains the exact explicit retry.

Admission requires an open runtime Test. Student transactions acquire the Test
lock before the StudentSession lock and recheck live authority and server time
after waits. Runtime states are `active`, `removed`, `readmitted` and `forfeited`;
an ended Test is an authorized parent projection, not a native release. Every
changed transition advances revision exactly once; stale comparison precedes
no-op detection and overflow rolls back all effects. A targeted claim preserves
its prepared epoch. Removal, re-admission preparation and forfeit invalidate
prior authority through the selected epoch changes.

Staff lists retain all six fractional UTC timestamp digits and order by
`created_at DESC, id DESC`, with 50 displayed rows and one lookahead. Code
issuance advances Test revision, so stale title/end intentions require explicit
reconciliation. Label-only changes preserve unrelated drafts; actual actor,
provider-session, School/Test or lifecycle changes discard affected private
intent. The existing provider client and refresh cycle are shared.

## Device and backend boundary

The five named routes are `student-session-challenge`, `student-session-join`,
`student-session-read`, `student-session-reconnect` and
`student-session-forfeit`. Exact bounded requests bind the configured API
origin, admission mode, operation, identity and candidate commitments. Initial
join and targeted re-admission have explicit modes with no fallback between them.
The database stores code/credential digests and the verified device public key;
raw device credentials and private keys remain in trusted desktop main.

Bootstrap uses a single-use 15-second challenge and a separate bounded quota.
Admitted maintenance verifies Ed25519 proof against the stored device key
before consuming its strictly increasing counter or allowance. Counter and
operation commit atomically. The allowance is 12 accepted operations per rolling
60 seconds per device/epoch; bootstrap key churn cannot debit it. Main coalesces
visible maintenance to one 15-second cycle, with renewal at 60 seconds remaining
replacing that cycle's read. Access/reconnect authority lasts at most 300/900
seconds. An unseen higher-counter request may arrive while its credential is
valid; counters do not establish a separate 15-second intent deadline.

Exact retries preserve the logical request, mode, key and credential candidates;
each maintenance attempt reserves a fresh greater counter before egress. Receipt
recovery returns original issuance/expiry metadata without extending authority.
Permanent Test/device bindings prevent an old device from creating a replacement
initial identity after rebinding. Lost credentials while a grant remains live
require staff removal followed by reviewed targeted re-admission. Public denial
remains generic and cannot establish whether the Test ended or a grant expired.

## Desktop persistence and protection state

Main owns the encrypted versioned record, committed authority, one exact pending
mutation and reserved counter. Version 4 records whether an initial join has not
been dispatched, may have committed, or was definitively denied. Before sending
the join request, main durably records uncertainty. Only a first-known definitive
denial can durably restore public-code entry; any earlier uncertain dispatch
remains uncertain even if a later request is denied. Challenge failures before
any join dispatch can also return to entry. A corrected code retains the same
device enrollment and replaces only the pending request and credential candidates.
Replacement requires no admitted authority, reserved counter, native protection
or retained evidence. Uncertain attempts keep exact retry and explicit targeted
re-admission; a generic denial never proves an earlier admission did not commit.

Version-1, version-2 and version-3 records normalize in memory without writing;
legacy pending joins are always uncertain. A successful version-4 write is a
forward format transition: earlier version-3 readers reject it and must not be
used for rollback. Rollback needs a version-4-compatible reader while preserving
the current encrypted record, lock and counter history; restoring older ciphertext
or clearing the record is not a recovery procedure.

Each persisted version-4 record appends `integritySha256`, the SHA-256 digest of
the UTF-8 JSON serialization of the complete compact record before that field is
added. It covers the version, generation, device material, pending intent,
authority, counters, protection facts and compact evidence. Loading verifies the
digest before semantic validation or legacy normalization. A missing or mismatched
digest preserves the ciphertext and blocks admission and targeted recovery.
The digest provides corruption detection, not authenticated integrity against a
hostile host. The unchanged 48 KiB plaintext budget includes the checksum field;
the ciphertext ceiling remains 64 KiB.

The selected macOS store uses a separate fixed
process-lifetime advisory-lock inode, exclusive temporary writes, exact
`F_FULLFSYNC` file and parent-directory barriers, and atomic replacement. It
retains possibly published bytes on uncertain durability; no failed barrier may
authorize egress, counter rollback or silent replacement. Initial unreadable or
unsupported records retain their bytes and block targeted recovery because prior
native ownership cannot be established. Known decoded terminal records retain
the separate explicit targeted-recovery path. Electron's
single-instance guard complements the native store lock.

The renderer receives named admission/recovery actions and sanitized view
snapshots, with trusted-frame/generation fencing. It receives no device key,
credential, counter, signing, arbitrary URL or storage interface. Confirmed
backend admission alone never attaches the calculator. The composed
[native protection owner](native-assessment-protection.md) receives a separate
trusted Start intent and requires all five categories, actual native begin,
a later authoritative backend read and durable lock state before attachment.
Unsupported native storage fails closed. A synthetic callback or compiled addon does not
establish assessment protection, recovery or OS-backed encryption acceptance.

## Migration and synthetic restore

The eleventh migration is
`supabase/migrations/20260908000300_student_session_admission.sql`. Its historical
aggregate remains
`aa32ed754c87e7987199dbd6c5f685ae65236ba3f94921157fc6cb07ce67b308`.
Its raw SHA-256 remains
`448d7697885eae07f04cc3b89531b7b3711e71fa67d56d80ac891df63458fb06`.
The historical twelfth migration is
`supabase/migrations/20260908000400_student_protection_evidence.sql`, with raw
SHA-256 `1543ee8cf236c4c43aa9331ec228eac9f99c68d4460d3023f68ce3a196fa2633`
and historical normalized aggregate
`80c2720ff352c721298e5814715374bf9e2a9c1152bbf2d2761ad781265f8701`.

The current thirteenth migration is
`supabase/migrations/20260908000500_student_preflight_evidence.sql`, with raw
SHA-256 `62ab37ff1ba85f475a64994645cfe9aaf17617e2f418400cd94d2161fc442d36`.
The current generation-4 migration-set digest is
`2ef021e3db72d5d2ef2602d1288d24b8a0fa20805a839aa96e49d778ff3ca49b`.
It adds only the exact failure-first preflight report prefix to the existing
historical evidence validator. Existing endpoint, signing domains, proof counters,
Teacher history and bounded retention remain unchanged. It does not grant admission
or infer native engagement from a failure report.
All twelve predecessors retain their bytes and historical pins; schema generation
`4`, fixture digest and seven-table archive are unchanged. See the
[exact inventory and normalization](reproducible-supabase.md#versioned-inputs).

The Student archive has 25 columns, including 20 added fields. Both fixed seed
sessions remain `created`, with the same IDs/School/Test/seed keys, creation time
`2000-01-01T00:00:00.000000Z`, epoch/revision one, counter zero, empty maintenance
allowance and null added name/device/credential/receipt fields. The six runtime
stores `student_join_materials`, `student_device_bindings`,
`student_bootstrap_challenges`, `student_bootstrap_limits`,
`student_device_proof_state` and `student_protection_events` must be empty in
pristine sources and targets and are never exported. The adapter must reject
wrong order/arity/nullability, nonpristine values and runtime table content.
The two evidence tables retain shared proof counters and historical client reports;
their addition does not change the seven-table archive or fixture framing/digest.
This source update supplies no new provider, SQL or restored-runtime receipt.

## Required evidence

After the desktop build, `npm run test:desktop:durability` runs the native store
checks and the production coordinator/store/crypto/transport against an owned
loopback HTTP fixture. The latter uses an explicitly synthetic codec; its server
checks persisted pending intent, counters and Ed25519 proofs before replying or
dropping a socket. It covers lost responses across process restarts, quarantine,
publication failure and whole-intent shutdown. This gate does not use the SQL
provider or the operating system's encryption service. Unsupported platforms do
not substitute a fake native implementation.

- Real Node/Edge Ed25519 interoperability and actual HTTP/SQL admission,
  maintenance, exact lost-response retry, remove/targeted claim/forfeit/end,
  copied-token denial, mode/origin/identity substitution and bounded failures.
- Observed concurrent Test/session lock waits, current authority/expiry checks,
  exact revisions/epochs/counters/allowances, and complete rollback on injected
  transaction/audit failures.
- Actual macOS helper build/load and owned synthetic durability/process-lock
  tests, crash/restart at publication boundaries, retained exact pending bytes,
  competing processes denied before record access or egress, and real desktop
  main/frame/generation integration. OS-backed encryption, hardware power loss,
  native assessment and packaged-device acceptance remain separately required.
- Production-entrypoint staff and Electron UI checks for stale reviews,
  same-document authority loss, generic denial, full entry/recovery visibility,
  no calculator occlusion and no protection claims from admission alone.
- The complete existing `test:staff-auth` chain, extended with Student groups,
  on the actual restored target without reset/reseed. The
  [restore gate](synthetic-restore-acceptance.md) requires exact Student metadata
  and empty stores through independent marker-retirement verification, including
  `studentMetadataPreserved` and `studentRuntimeStoresEmpty` receipt flags.

Exact-candidate checks and independent source review must establish these gates.
Historical School/Test/restore receipts and source-only checks do not establish
StudentSession runtime completion or authorize hosted deployment or native lock
engagement.
