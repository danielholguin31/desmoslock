# Internal Staff web on Vercel

`apps/web/vercel.json` configures only the v2 Staff web application. The
repository-root `vercel.json` remains the legacy deployment tombstone; its skip,
refusal and historical download configuration must not be used for this project.
This source configuration does not authorize a deployment or establish hosted
Staff authentication, email delivery or backend readiness.

## Project settings

Use a dedicated project in the selected Vercel account. An empty project is
sufficient; do not reuse a legacy project or connect a different login identity.

| Setting                                                           | Value                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Root Directory                                                    | `apps/web`                                                                                        |
| Include source files outside the Root Directory in the Build Step | Enabled                                                                                           |
| Framework Preset                                                  | Other                                                                                             |
| Output Directory                                                  | `dist`, relative to `apps/web`                                                                    |
| Install Command                                                   | `cd ../.. && npm ci`                                                                              |
| Build Command                                                     | `cd ../.. && npm run build:packages && npm run build --workspace @desmoslock/web -- --production` |
| Ignored Build Step                                                | No legacy ignore command                                                                          |

The outside-source setting is necessary for the root lockfile, build script and
workspace packages. The build compiles packages and web only; the root aggregate
`npm run build` also builds the desktop app and is not the web deployment command.
Production mode omits web source maps. Use the reviewed source commit and the
repository's Node.js 24.20.0/npm 11.12.1 toolchain; a hosted Node major-version
selection alone does not prove the exact toolchain. Verify actual versions before
accepting a hosted build. Do not loosen the repository pin to accommodate a
provider default.

Vercel's [monorepo instructions](https://vercel.com/docs/monorepos) describe the
project root; its [monorepo FAQ](https://vercel.com/docs/monorepos/monorepo-faq)
documents outside-root source access. The app configuration follows the current
[Vercel schema](https://openapi.vercel.sh/vercel.json) and
[configuration reference](https://vercel.com/docs/project-configuration/vercel-json).

## Public build inputs

Supply all four public values through the selected build environment:

- `DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT=staging`
- `DESMOSLOCK_PUBLIC_BACKEND_URL`: the approved staging Supabase HTTPS origin
- `DESMOSLOCK_PUBLIC_WEB_ORIGIN`: the exact selected HTTPS Staff origin
- `DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: that backend's browser-public key

No origin, key, account or project identifier is embedded in this configuration.
Existing build validation rejects missing or partial values and invalid origins.
Service-role keys, database credentials and mail credentials are never browser
build inputs. A generated preview URL is not automatically an approved Staff
origin: the browser requires its runtime origin to match the compiled value.
Choose the stable origin before the final build and align backend CORS, Auth
site/redirect settings and callback configuration with that same origin.

## Routes and assets

The current Staff application and every supported authentication callback use
`/`, with query or fragment state. The callback parser deliberately rejects
other pathnames. Normal static serving therefore supports the actual SPA routes
without a catch-all rewrite. Root query strings reach `index.html`; fragments
remain in the browser. No redirect is introduced before the inline callback
scrubber runs.

Serve `main.js`, `styles.css`, `auth/staff-auth.css`,
`school-settings/school-settings.css`, `test-workspace/test-workspace.css` and
`student-sessions/student-session.css` from their built paths. Missing assets or
unsupported paths should return 404, not the HTML shell. Responses disable
referrer disclosure and caching; assets have stable filenames rather than
content hashes, so old application code must not be retained across deployments.

## Existing empty project without Git access

Creating the project does not grant repository access or deploy source. Keep the
selected Google login. A separate Git connection is not required for a later
explicitly authorized CLI deployment. Vercel's
[prebuilt deployment flow](https://vercel.com/docs/cli/deploy#prebuilt) consumes
`.vercel/output` produced by its build flow, not a bare `dist` directory. Do not
claim that the existing web build alone produced that deployment format.

Before that later operation, verify the selected project/account, the exact app
configuration and root settings, the CLI/runtime versions and all four public
inputs. Use only reviewed source/artifact inputs; do not upload a dirty working
directory or environment files. Source upload, linking, environment changes and
deployment have not been performed by adding these files.

Hosted acceptance still requires the reviewed staging database/function upgrade,
matching callback/CORS/redirect settings, verified From/Reply-To and mail domain,
the selected invitation mail provider configuration, Auth email templates and a
real delivered-mail browser journey. Local source checks do not establish those
gates. See [the public configuration contract](reproducible-supabase.md) and
[the authentication rollout prerequisite](auth-integration-evidence.md).
