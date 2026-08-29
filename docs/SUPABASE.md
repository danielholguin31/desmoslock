# DesmosLock on Supabase

> **Historical v1 evidence only.** The project state and dashboard instructions
> below are a retained snapshot, not current v2 authority. Do not change a
> hosted project or authentication setting from this document; v2 uses the
> repository migrations and requires a separately authorized remote gate.

**Status: live.** Project `thebestprojectofall` (`xoholqrbhgffivvklpvd`) has the schema
applied, and the app defaults to it. Two provider settings still need flipping in the
dashboard before students can join — see [Finish the setup](#finish-the-setup).

## What is already done

- [`supabase/schema.sql`](../supabase/schema.sql) is applied: 5 tables, 9 RLS policies,
  10 functions, the alert trigger, the new-teacher trigger, and the realtime publication.
- The desktop app talks to it through [`desktop/renderer/backend.js`](../desktop/renderer/backend.js).
- `desktop/renderer/config.js` holds the project URL and publishable key.

Re-running `schema.sql` is safe — it's idempotent.

## Finish the setup

Both are in **Authentication → Providers**, and both are one toggle:

| Setting | Now | Needs to be | Why |
| --- | --- | --- | --- |
| **Anonymous sign-ins** | disabled | **enabled** | Students get a JWT without an account. Row-level security and realtime filtering are both keyed on `auth.uid()`, so without it a student cannot join at all. |
| **Email → Confirm email** | enabled | **disabled** (or configure SMTP) | A teacher who registers gets no session until they click a confirmation link. With no SMTP sender configured, Supabase's built-in email is rate-limited to a couple an hour and often never arrives. |

Until then the app fails with a message that says exactly this, rather than something
generic — see `friendly()` in `backend.js`.

## Applying migrations

The direct database host is IPv6-only, which fails on networks without an IPv6 route
(including this one). Use the IPv4 pooler in **session mode**:

```
host  aws-1-us-west-2.pooler.supabase.com
port  5432
user  postgres.xoholqrbhgffivvklpvd
```

Port 6543 is transaction mode and will not run DDL.

## The security model

Three decisions worth keeping if you extend this.

**The override code never reaches a student client.** It lives in its own
`test_secrets` table with a teacher-only policy, and `use_override(code)` compares it
inside the database. On the `tests` row, the student read policy would hand it
straight over — anyone who opened dev tools would own the classroom.

**Severity is decided in the database.** Students file their own alerts, so a patched
client could lie about the `kind`. The `alerts_before_insert` trigger sets `severe`
and bumps `students.flags`, so the roster count cannot be talked down from outside.
Verified: a client inserting `severe: false` on a `quit_attempt` is overruled.

**A student can read exactly one test and one student row.** Proven by test:
before joining, `select * from tests` returns `[]`; after joining it returns one row,
and `test_secrets` stays empty in both cases. A student cannot unlock themselves by
RPC or by `PATCH`, and cannot read the alert feed.

## Two gotchas that cost real time here

**Realtime authenticates separately from REST.** When a second user signs in on the
same client, the realtime socket keeps the *old* JWT and silently drops rows the new
user is allowed to see — no error, just a roster that never updates. `syncRealtimeAuth()`
pushes the token on every auth change. This was a live bug, found and fixed.

**PL/pgSQL OUT parameters collide with column names.** `join_test` returns
`(test_id, student_id, …)`, and its `ON CONFLICT (test_id, user_id)` was ambiguous —
error 42702. Fixed with `#variable_conflict use_column`.

## Cloud vs local

The app ships both backends and remembers which one you picked (landing screen →
*change*). Type `cloud` or a server address.

Supabase means students need **real internet**. The LAN server in [`server/`](../server/)
works with the uplink down, which is why it still exists — a test is the wrong moment
to discover the school's connection is flaky. Cloud is the better default for take-home
or 1:1 laptop programs.

## Not changed, and shouldn't be

The whole of [`desktop/main.js`](../desktop/main.js). Coverage, the watchdog, the
shortcut net, per-display blockers, the force-quit-and-relaunch path — none of it knows
which backend produced the lock signal, and that seam is what made swapping backends a
day's work instead of a rewrite.
