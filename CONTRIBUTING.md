# Contributing to DesmosLock

Thanks for taking the time to help. DesmosLock is maintained by two people, so
small, focused pull requests get reviewed fastest.

## Before you start

- Search the [issues](https://github.com/danielholguin31/desmoslock/issues)
  first. For anything larger than a bug fix, open an issue describing the
  change before writing code.
- Report security problems privately as described in [SECURITY.md](SECURITY.md),
  not in a public issue.
- Work only in the v2 workspace: `apps/`, `packages/`, `supabase/`,
  `scripts/`, and `tests/`. The legacy v1 code is not accepted as a base for
  new work.
- By contributing, you agree that your contribution is licensed under the
  [GNU Affero General Public License v3.0](LICENSE).

## Set up

Use exactly Node.js 24.20.0 and npm 11.12.1. The versions are pinned in
`.node-version` and `package.json`, and other versions are not supported.

```bash
npm ci
```

Database and staff-auth tests also need Docker. The pinned Supabase CLI is
installed by `npm ci`.

## Checks to run

Run these before opening a pull request:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run verify:repository
```

Run the lanes that match what you changed:

| You changed                     | Also run                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `apps/web`                      | `npm run test:web`                                                           |
| `apps/desktop`                  | `npm run test:electron` (macOS)                                              |
| `supabase/migrations` or seed   | `npm run db:start`, `npm run db:reset`, `npm run test:db`, `npm run db:stop` |
| `supabase/functions`            | `npm run test:edge`                                                          |
| Staff auth, invitations, access | the staff-auth lane in [docs/maintainers.md](docs/maintainers.md)            |

`npm run format` fixes formatting. CI runs all of these on every pull request,
plus dependency, secret, and workflow checks.

## Pull requests

- Branch from `main` and target `main`.
- Keep one change per pull request, and explain what changed and why.
- Add or update tests for behavior changes. Database changes go in a new
  migration file; do not edit migrations that are already on `main`.
- Do not commit credentials, `.env` files, real student or staff data, or
  build output. Fixtures must be synthetic.
- Update documentation when behavior or commands change. Some docs are
  checked by `tests/repository-contract.test.mjs`, so run `npm test` after
  editing them.
- Fill in the pull request template, including which checks you ran.

## Code owners

[`.github/CODEOWNERS`](.github/CODEOWNERS) requires review from both
maintainers for changes to `.github/workflows/`, `package.json`,
`package-lock.json`, `scripts/verify-*.mjs`, and `vercel.json`. These files
control CI and release safety, so expect slower and closer review there.

## Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
