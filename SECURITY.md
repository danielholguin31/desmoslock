# Security policy

## Supported versions

Only the `main` branch is supported. The legacy v1 code at the `v1.0.0` tag
gets no security fixes, and there is no released v2 build yet.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Security Advisories. Open the
[Security tab](https://github.com/danielholguin31/desmoslock/security) and
choose **Report a vulnerability**. Do not open a public issue, pull request,
or discussion for a security problem.

If the **Report a vulnerability** button is missing, open a public issue that
asks a maintainer for a private contact. Do not include any details of the
problem in that issue.

Include what you can of the following:

- the affected component (`apps/desktop`, `apps/web`, `supabase/`, or a
  package) and the commit you tested
- steps to reproduce, and what happened compared with what you expected
- the impact, for example which data or which lockdown guarantee is affected

We will acknowledge the report, keep you updated while we work on it, and
credit you in the advisory unless you ask us not to.

## Scope

In scope:

- Lockdown bypasses: any way for a student to leave the calculator, reach
  other apps, windows, or the network, capture the screen, or end a session
  without it being recorded as a forfeit, while assessment protection is
  active.
- Ways to tamper with, replay, or forge student session records or protection
  evidence sent to the backend.
- Staff authentication, invitation, recovery, and authorization flaws,
  including reading or changing data in another School.
- Row-level security, RPC, or Edge Function flaws in `supabase/`.
- Secrets or credentials committed to the repository.

Out of scope:

- The legacy v1 code at the `v1.0.0` tag.
- Attacks that need administrator access to the student's Mac before the
  session starts, or physical access to a staff member's unlocked device.
- Findings against third-party services (Apple, Supabase, Vercel, GitHub)
  that are not caused by how this repository uses them. Report those to the
  vendor.
- Denial of service through traffic volume.
