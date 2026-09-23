# Historical source recovery snapshots

These patches preserve parked, superseded or unfinished local work for Daniel. They are **unreviewed archival material, not approved implementation or release evidence**. Current main is authoritative. Retain native Apple assessment protection; a weaker kiosk mode was rejected.

`manifest.json` records each exact source ref, source/base commit, original workspace path, file list, patch SHA-256 and size. Branch patches are the cumulative delta from their recorded merge base; worktree patches combine tracked changes and eligible added source/document files from the recorded HEAD. All patches passed `git apply --cached --check` against a temporary index loaded from that exact base. This validates reconstruction syntax, not behavior or compatibility with current main.

To inspect a snapshot, create an isolated checkout at its `baseCommit`, verify its SHA-256 and apply only that patch. Do not stack unrelated patches or apply them directly to main. Preserve base history in this repository. Some snapshots overlap work integrated under different commits; absence from current remote refs does not prove the work was never published.

The custom server PKCE broker, password commit-receipt protocol and abandoned mail-outbox proposals remain parked. Reusing any requires a fresh requirements and code review. No tests were run on archival snapshots during handoff.

Excluded: dependency trees (`node_modules`), environment/credential/secret files, binary builds and runtime data. Original worktrees remain untouched.
