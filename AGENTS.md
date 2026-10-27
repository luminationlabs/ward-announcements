# AGENTS.md

Guidance for anyone — person or coding agent — working in this repository. Keep it current: when the architecture, the commands or the docs change, update the pointer here.

## What this is

**Ward Announcements** — a small installable web app (PWA) for a ward of The Church of Jesus Christ of Latter-day Saints. Members open it from a link (or its home-screen icon) and see the current announcements, the **sacrament meeting program** (readable only on the meeting day, inside a time window), and standing **resource** pages. They can turn on a weekly push notification that links to the updated list. Clerks and other leaders edit it all from a dashboard. It is not an official service of the Church, and says so (`DISCLAIMER` in `src/views.ts`) on the member app, the locked page, the dashboard's sign-in and invite pages and the operator page (`test/access-gate.test.js`, `test/hardening.test.js` and `test/operator-core.test.js` check). The printed flyer and the emailed announcements PDF carry no such line: they are a ward's own notices, like any other on the board or in the inbox.

It runs three ways from one codebase:

- **One ward on its own Cloudflare account** (Workers + D1; the Deploy to Cloudflare button).
- **Many wards on one deployment** (`src/host.ts`: one SQLite Durable Object per ward, an operator page to create and manage them).
- **A Node server** (`src/server.ts`, SQLite on disk) — local development, the tests, and Docker.

## Goals & constraints

- **Reliable on iPhones first.** Most members use iOS, where push works only for an app added to the home screen; install guidance and delivery reliability come before features.
- **Simple and self-contained.** TypeScript, SQL, no front-end framework, no native dependencies in the build.
- **Low traffic.** About one push a week plus the odd manual one; a ward is a few hundred people.
- **Privacy by default.** The whole site sits behind a member access code; programs name people and are readable only in their window; old programs are purged on a clock.

## Architecture (one paragraph)

A Hono app (`src/app.ts`) serves the API and the server-rendered dashboard, and the static PWA from `public/`. Storage goes through a driver seam (`sqldriver.ts` → `driver-sqlite.ts` / `driver-d1.ts` / `driver-do.ts`), so `db.ts` is plain positional SQL; images go through a second seam (`filestore.ts` → a directory, an R2 bucket, or the database itself). Per-ward state lives in `tenantLocal()` slots (`src/tenant.ts`) rather than module globals, so one process can serve many wards. Pushes use Declarative Web Push payloads, encrypted with WebCrypto, and are **queued and drained in chunks** (a free-plan Worker gets ~10 ms of CPU per invocation). Scheduled work — the weekly digest, retries, the daily purge — is `src/tick.ts`, run by a per-minute cron on the single-ward Worker, by croner on Node, and by each ward's own Durable Object alarm on the many-ward host. The member gate is always on: a shared code delivered by link fragment, a member cookie signed with a database-held secret, per-device tokens for installed apps. The dashboard's owner signs in with `ADMIN_PASSWORD`; everyone else is a person with passkeys, an **admin** or a reduced **editor**, enforced by `requireAdmin` on the routes. Content is Markdown, edited in a visual editor (`editor/`, Tiptap) that reads and writes it. Full detail: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Docs

- [README.md](./README.md) — what it is and how a ward gets it, for a ward's clerk.
- [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) — every way to run it, the env vars, backups, the many-ward host's deploy checklist, and what a hosted ward should know about privacy.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — stack, repo layout, push flow, endpoints, design decisions, and the accepted security risks.
- [art/README.md](./art/README.md) — the icon artwork, and how to use your own building.
- [CONTRIBUTING.md](./CONTRIBUTING.md), [SECURITY.md](./SECURITY.md), [CHANGELOG.md](./CHANGELOG.md) — for outside contributors, private security reports, and what each release changes.

## Commands

```bash
npm install
cp .env.node.example .env   # fill in ADMIN_PASSWORD (+ PUBLIC_ORIGIN in production)
npm run dev                 # Node: http://localhost:3000

cp .dev.vars.example .dev.vars
npm run cf:dev              # Workers (wrangler dev): http://localhost:8787
```

`npm run build` compiles to `dist/` and regenerates the icons, the vendored pdfmake copy, the editor bundle and the passkey bundle (`npm run assets`). `npm run deploy` deploys the ward-neutral template (`wrangler.jsonc`, what the Deploy button uses); `npm run cf:deploy` deploys your own ward from a git-ignored `wrangler.production.jsonc`; `npm run host:deploy` deploys the many-ward host from a git-ignored `wrangler.host.production.jsonc` (see `wrangler.host.example.jsonc`). Push *subscription* needs HTTPS or `localhost`, so a phone needs a deployed address. `npm run screenshots` rebuilds and regenerates the README's four images (`docs/images/`) from a fictional ward — three photographed pages and a drawn mock-up of the notification, photographed with the local Google Chrome running headless (`scripts/screenshots.mjs`); look at them before committing.

## Tests

| Command | What it runs |
| --- | --- |
| `npm test` | Every `test/*.test.js` on Node: a real server on a throwaway database, plus in-process suites. |
| `npm run test:worker` | The HTTP suites against `wrangler dev` (the real Workers runtime, local D1), then attachments with R2 bound. |
| `npm run test:host` | The same suites against the many-ward host, then `test/host/` (Durable Object driver, cross-ward isolation, alarms, images, operator, owner sign-in, people, export and import). |

None of them needs a Cloudflare account or deploys anything. Run **`npm test`** before touching `src/access.ts`, `src/auth.ts`, `src/passkeys.ts`, the gate middleware in `src/app.ts`, `src/programs.ts`, `src/meeting.ts` or `src/push.ts` — the paths that can lock a ward out, show members' names on the wrong day, or silently drop subscribers. Run **`test:worker`** after touching `worker.ts`, `app.ts`, `db.ts` or either seam (it catches Node-only assumptions), and **`test:host`** after touching `host.ts`, `operator.ts`, `driver-do.ts`, `tenant.ts` or `tick.ts`. The Workers runs start several `wrangler dev` servers; a rare boot timeout under load is worth one re-run before chasing.

## Database reset & restore

`scripts/db-reset.mjs` and `scripts/db-restore.mjs` print SQL and never touch a database, so the destructive step is always one you run yourself. `db-restore.mjs` takes the dashboard's backup ZIP (or its JSON) and writes the ZIP's images to a folder; what a restore means is `src/restore.ts`, shared with the many-ward host's Import Backup. Order after a wipe: **reset → open the site once → restore**. Recipes in [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md#resetting-the-database).

## Conventions

- TypeScript ESM; small modules. Write code that reads like the code around it, comments included: they explain *why*, often with the incident that made a rule necessary.
- Keep `app.ts` and everything it imports **runtime-neutral**: no `process`, no filesystem, no Node built-in beyond what Workers' `nodejs_compat` covers (`node:crypto`, `Buffer`, `node:async_hooks`). Runtime-specific code lives in `server.ts`, `worker.ts` or `host.ts`.
- `db.ts` is positional SQL (`?`), and every atomic write goes through `batch()` — D1's limits.
- **Inline scripts open with `${scriptTag()}`** (`src/csp.ts`), never a bare `<script>`, and there are no inline event handlers (`onclick=`, `onsubmit=`): the Content Security Policy refuses both, and the page then silently does nothing in a browser. Confirmations use `data-confirm="…"`. `test/hardening.test.js` checks every page.
- **No module-level mutable state in `src/`.** Hold it with `tenantLocal()` (`src/tenant.ts`). `test/tenant.test.js` fails on a new module-level `let` or Map/Set unless it is added to its reviewed list with a reason.
- A Worker entry module (`worker.ts`, `host.ts`) may export only handlers and classes — workerd refuses to start otherwise (`test/operator-core.test.js` checks).
- Schema changes are additive migrations in `db.ts` (`SCHEMA_VERSION`), run automatically at boot, and must chain from any older version: deployments skip releases. Note a `SCHEMA_VERSION` bump, and anything a ward must do by hand, in `CHANGELOG.md`.
- Never commit secrets: `.env`, `.dev.vars` and the `*.production.jsonc` configs are git-ignored; the `*.example` files document them.
