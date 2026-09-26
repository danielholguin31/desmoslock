# DesmosLock v2 feature map

These are the user-facing v2 surfaces, taken from `apps/web`, `apps/desktop`, and `supabase/functions`. Each file follows the verification-skill shape: Sub-features, How to get to it, Driving it, Gotchas. Source paths are listed in each file. Anything the source does not settle is marked **unverified**.

"Exercised" means driven by `scripts/verify-desmoslock.mjs` on the Mac Mini (macOS, Node 24.20.0) with evidence under `.verify-evidence/<run>/`. "Not exercised" means only the listed repository tests cover it, and those were not run for this skill.

The web app has one route path, `/`. Views are state-driven, and callbacks arrive through the query strings `?auth=invite`, `?auth=email-verification`, and `?auth=recovery`.

| Feature | Surface | Status |
| --- | --- | --- |
| [Web shell and backend status badge](web-shell-backend-status.md) | apps/web | exercised (`web`) |
| [Staff password sign-in and email verification](web-staff-sign-in.md) | apps/web | exercised (`web`), with synthetic Auth stubs |
| [Staff invitation callback](web-invitation-callback.md) | apps/web | exercised (`web`), failure path only |
| [Staff password recovery](web-password-recovery.md) | apps/web + supabase/functions/account-recovery | not exercised |
| [Staff TOTP second factor](web-mfa-totp.md) | apps/web | not exercised |
| [Staff session controls (sign out)](web-session-controls.md) | apps/web | not exercised |
| [Staff management (invitations, roles, revocation)](web-staff-management.md) | apps/web + supabase/functions/staff-invitations | not exercised |
| [School settings](web-school-settings.md) | apps/web | not exercised |
| [Test workspace (create, open, end Tests)](web-test-workspace.md) | apps/web | not exercised |
| [Teacher student-session management and client reports](web-student-sessions.md) | apps/web | not exercised |
| [Desktop trusted shell window](desktop-trusted-shell.md) | apps/desktop | exercised (`desktop`, `electron-suite`) |
| [Desktop preload bridge and IPC channels](desktop-trusted-bridge-ipc.md) | apps/desktop | exercised (`desktop`), in part |
| [Student join with a Test code](desktop-student-join.md) | apps/desktop | exercised (`desktop`), failure path only |
| [Student session retry, refresh, leave, and re-admission](desktop-student-session-lifecycle.md) | apps/desktop | not exercised |
| [Assessment protection (AAC lockdown) and emergency exit](desktop-assessment-protection.md) | apps/desktop | not exercised; idle state observed |
| [Isolated calculator surface](desktop-calculator-surface.md) | apps/desktop | exercised (`electron-suite`) |
| [Durable local Student record](desktop-durable-student-record.md) | apps/desktop | indirectly exercised (`desktop`) |
| [Protection evidence delivery](desktop-evidence-delivery.md) | apps/desktop + supabase/functions/student-session-evidence | not exercised |
| [Edge function: health](edge-health.md) | supabase/functions/health | fixture only |
| [Edge function: account-recovery](edge-account-recovery.md) | supabase/functions/account-recovery | not exercised |
| [Edge function: staff-invitations](edge-staff-invitations.md) | supabase/functions/staff-invitations | not exercised |
| [Edge functions: student-session-*](edge-student-session.md) | supabase/functions/student-session-{challenge,join,read,reconnect,forfeit,evidence} | not exercised |

Count: 22 features.

Legacy top-level `desktop/`, `server/`, and `web/` are v1 evidence only. They are out of scope and must not be run.
