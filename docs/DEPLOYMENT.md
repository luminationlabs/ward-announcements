# Deployment

Three deployment shapes, from one codebase:

- **[Cloudflare Workers + D1](#2a-cloudflare-workers-primary)** — the primary path. No server, no volume, no TLS to arrange, and it fits inside the free plan. A new ward can do it from the **[Deploy to Cloudflare button](#the-deploy-to-cloudflare-button)** with a password and its name.
- **[Many wards on one deployment](#2b-hosting-many-wards-one-deployment)** — one Cloudflare Worker serving any number of wards, each in its own Durable Object, with an operator page to add and manage them.
- **[Node or Docker on your own server](#4-node-or-docker-on-your-own-server)** — a single Node process with SQLite on disk, for a ward that already runs a server (and what `npm run dev` runs locally).

Everything outside the runtime-specific sections — the environment variables, the access gate, verification — applies to all of them.

**Web Push requires HTTPS.** Cloudflare provides it; on your own server, the reverse proxy in front of the app does.

## 1. VAPID keys (optional)

Leave `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` unset and the app generates a pair on first boot and keeps it in the database's `settings` table (`src/identity.ts`). The dashboard's backup carries that pair only **sealed** under a `BACKUP_SEAL_KEY` you set (see [Backups](#3a-backups)), or not at all: a restore over the same database keeps the pair either way, a restore onto a fresh deployment with the same seal key gets it back, and a restore anywhere else sends with a new pair — the installed apps re-subscribe on their next launch, and everyone else turns notifications on again. To pin a pair of your own instead:

```bash
npm run vapid
```

It prints a `BACKUP_SEAL_KEY` too; set that whether or not you pin the pair. Keep the **private** key secret, and set both or neither (half a pair is a boot error). Keys in the environment always win over a stored pair. **Treat the pair as permanent**, whichever way you got it. Changing it later invalidates every existing subscription: the push service refuses each delivery made with the new key. Installed apps notice the new key on their next launch (the page and the service worker compare it with the subscription's) and re-subscribe by themselves; a member who has not opened the app since stops receiving notifications until they do, and one using a browser tab rather than an installed app turns notifications on again. If you ever must rotate, expect a week or two of members trickling back.

## 2. Environment variables

On Workers these are `vars` in `wrangler.jsonc` (non-secret) plus `wrangler secret put` values for the passwords (and VAPID keys, if pinned); on Node they are process env vars from `.env` (template: `.env.node.example`). `PORT` and `DATABASE_PATH` are Node-only — a Worker has no socket of its own and its storage is the D1 binding.

**Ward settings** — `APP_NAME`, `APP_SHORT_NAME`, `APP_DESCRIPTION`, `APP_FOOTER`, `LINK_TEXT` / `LINK_URL` and `TZ` — are only **starting values**. An admin edits them on the dashboard (Settings → Ward Settings), and once that card has been saved the saved values win: changing the var afterwards does nothing. A rename reaches installed apps through the usual silent update, except the home-screen label, which a phone only reads when the app is installed. On Node, changing the timezone reschedules the weekly send straight away; the daily program-retention sweep keeps its old hour until the next restart. The weekly send and the program window are local times, so fixing the timezone keeps them at the same time of day in the new zone.

| Var | Example | Notes |
| --- | --- | --- |
| `APP_NAME` | `Ward Announcements` | **Required.** Full title (page, header, install steps, push title, manifest `name`) |
| `APP_SHORT_NAME` | `Ward` | **Required.** Home-screen icon label (manifest `short_name`; keep it short) |
| `APP_DESCRIPTION` | `Current ward announcements with weekly notifications.` | **Required.** Manifest `description` + page meta description |
| `APP_FOOTER` | `Intended for members and friends of the Example 2nd Ward.` | Optional audience note in the public footer, above the fixed "not an official service of The Church of Jesus Christ of Latter-day Saints" line that every deployment shows |
| `LINK_TEXT` / `LINK_URL` | `Visit the ward website` / `https://sites.google.com/...` | Optional link shown below the announcements; both must be set or nothing shows |
| `VAPID_PUBLIC_KEY` | `BNc...` | Optional — see step 1. Generated and stored when unset |
| `VAPID_PRIVATE_KEY` | `x1y...` | Optional secret — set with the public key or not at all |
| `VAPID_SUBJECT` | `mailto:you@example.org` | Contact address push services require; must be `mailto:` or `https:`. Optional: blank uses the public origin |
| `BACKUP_SEAL_KEY` | `rRUl…` (43 chars) | Optional secret: 32 random bytes, base64url (`npm run vapid` prints one). Seals the push keys inside the dashboard's backup (and the operator's export on the host), so a restore on this deployment keeps every subscription while the file alone cannot send. Unset: the backup leaves the keys out. Keep it the same across redeploys, or older backups stop opening; a value that is not 32 bytes stops the app from starting in production. Host-wide on the many-ward host |
| `ADMIN_PASSWORD` | (a long passphrase) | Password for the `/admin` owner sign-in. Changing it ends open owner sessions. Does not affect members. Well-known example values (`changeme`, `password`, …) stop the app from starting, with a message saying so |
| `PORT` | `3000` | **Node only.** The plain-HTTP port the app listens on, which the HTTPS reverse proxy forwards to |
| `TRUST_PROXY` | `1` | **Node only.** `1`, `true` or `yes` when a reverse proxy is in front, so rate limits use the client address the proxy saw (the last `X-Forwarded-For` entry). Unset, only the socket address counts, and every forwarded header is ignored as the client's own. See [HTTPS in front](#https-in-front) |
| `DATABASE_PATH` | `/data/app.db` | **Node only.** Must live on a persistent volume |
| `UPLOADS_PATH` | `/data/uploads` | **Node only.** Images attached to announcements. Defaults to `uploads/` beside `DATABASE_PATH`, so the same volume covers both; set it only if they must live elsewhere |
| `PUBLIC_ORIGIN` | `https://announcements.example.org` | Absolute origin for notification links (Declarative Web Push on iOS 18.4+), share links and the QR. **Workers:** optional — when unset it is learned from the first https visit a signed-in *admin* makes to `/admin`, and stored; the first one sticks, so set this var when you move to a custom domain. **Node:** required in production, since behind a TLS-terminating proxy it can never see an https origin to learn |
| `TZ` | `America/Denver` | The ward's starting timezone (an IANA name); **Ward Settings** in the dashboard overrides it. Blank means the default; a name that isn't a real zone stops the app from starting, with a message saying so |
| `NODE_ENV` | `production` | `production` marks cookies `Secure`, makes `PUBLIC_ORIGIN` required on Node, and accepts push subscriptions only from real push services. The Workers templates set it |
| `PUSH_CHUNK_SIZE` | `12` | Subscribers delivered per drain of the send queue (1–90). Sized for the Workers free plan; raise it only with a measurement behind it |
| `IMAGE_QUOTA_MB` | `250` | Most image storage one ward may use; an upload that would pass it is refused. Unset or `0`: no limit. Meant for the many-ward host, but read everywhere |
| `IMAGE_STORE` | `database` | **Node only.** Keep images in the database (`file_chunks`) instead of `UPLOADS_PATH`. Mostly for the tests |

The many-ward host adds `OPERATOR_HOST`, `WARD_DOMAIN` and `WARD_OWNER_SIGNIN`; see [§ 2b](#2b-hosting-many-wards-one-deployment).

## 2a. Cloudflare Workers (primary)

Everything the app needs on Cloudflare is declared in `wrangler.jsonc`: the `ASSETS` binding for `public/`, the `DB` D1 binding, the cron trigger, and the non-secret `vars`. That file is a **template**: no database id, no domain, no ward. It is what the Deploy button and `npm run deploy` read. A deployment you keep updating from your own machine lives in a copy of it, `wrangler.production.jsonc` (git-ignored), which `npm run cf:deploy` uses — see [Your own deployment](#your-own-deployment) below.

What a fresh deployment does for itself, so none of it is a setup step:

- **The database** is created by Wrangler on first deploy (no `database_id` in the template), and the Worker creates its own tables on its first request (`initDb()`). There is no migration step.
- **The VAPID keys** are generated on first boot and stored (step 1).
- **The public address** is learned the first time the admin opens `/admin` over https (`PUBLIC_ORIGIN` in the table above). Until then, notifications wait in the queue rather than going out without a contact address — so sign in once before the first Sunday.
- **Images** are stored in D1 (`src/filestore-sql.ts`, the `file_chunks` table) because the template binds no R2 bucket: enabling R2 asks for a payment card even on its free tier. D1's free 5 GB holds years of flyers. The dashboard's ZIP backup carries them (it fetches each one from `/images/:key`, which serves D1's images like any other); the data-only JSON leaves them out, as it does R2's.

### The Deploy to Cloudflare button

The README carries the button, pointing at this repository:

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/luminationlabs/ward-announcements)
```

A fork that wants its own button points the `url` at its own public repository.

Whoever presses it signs in to (or creates) a free Cloudflare account, and the flow then:

1. Forks the repository into their own GitHub/GitLab account, so they can pull updates later.
2. Creates the D1 database named in the template.
3. Asks for each `vars` value, with the descriptions in `package.json` → `cloudflare.bindings`: the ward's name, short name, description and timezone (and `NODE_ENV`, to leave as `production`). The form will not take a blank field, so the optional settings are not in the template at all: the footer note is on the dashboard's **Ward Settings**, the address is learned on the first visit to `/admin`, and `VAPID_SUBJECT` falls back to that address. To pin either of those later, see `npm run cf:deploy` below.
4. Asks for the secrets in `.dev.vars.example` — just `ADMIN_PASSWORD`. That file therefore lists **secrets only**: anything else in it would be prompted for as a secret. (The Node template is named `.env.node.example` rather than `.env.example` because the button reads that name too.)
5. Builds with `npm run build` and deploys with `npm run deploy` (`npm run assets && wrangler deploy`), and keeps doing so on every push to their fork (Workers Builds). The build runs on the Node in `.node-version` with the npm in `package.json` → `packageManager`; both are pinned because Workers Builds' default npm 10 would try to compile `better-sqlite3` (the Node server's database, unused on Workers — see the note in the Dockerfile), and npm 12 does not.

The ward then opens `https://ward-app.<their-subdomain>.workers.dev/admin`, signs in, and is done. Everyone else is added from the dashboard (**Settings → People**) and signs in with their own passkey; see [Passkeys and the site's address](#passkeys-and-the-sites-address).

The icon is the generic meetinghouse (`art/chapel-mask.png`) unless a ward adds its own; see [art/README.md](../art/README.md).

### By hand, from a clone

```bash
npm install
npx wrangler login
npx wrangler secret put ADMIN_PASSWORD --name ward-app   # or after the first deploy, without --name
npm run deploy                                             # creates the database, then deploys
```

Edit the `vars` in `wrangler.jsonc` first (name, short name, `TZ`). Wrangler creates the database on the first deploy; later deploys of the same Worker name inherit that binding from the deployed Worker, so the template never needs the id. To pin it anyway (and anything else of your own), copy the file to `wrangler.production.jsonc` and use `npm run cf:deploy` from then on. If the Worker already deployed is the template's `ward-app`, keep that `name` in the copy — another name is another Worker, at another address, with its own database — and never run `npm run deploy` from this checkout again.

### Your own deployment

`npm run cf:deploy` deploys with `wrangler.production.jsonc`: the template plus whatever you pin — the `database_id`, an `IMAGES` R2 bucket, a custom domain under `routes` (with `workers_dev: false`), `PUBLIC_ORIGIN` and `VAPID_SUBJECT` in `vars`, and the VAPID keys as secrets. Anything you pin there is used as-is; only what is left unset is generated or learned. For a new deployment, give the Worker a `name` other than the template's `ward-app`, so a stray `npm run deploy` cannot replace it with the template's empty database (a deployment already named `ward-app` keeps its name; see above).

To use R2 for images (it streams rather than buffering, and keeps the bytes out of D1):

```bash
npx wrangler r2 bucket create <bucket>     # may ask for a payment method; usage stays free
```

and add `"r2_buckets": [{ "binding": "IMAGES", "bucket_name": "<bucket>" }]`. Images already stored in D1 are not moved — a deployment switching over should do it before any are uploaded.

**Custom domain.** Add it in the Cloudflare dashboard under the Worker's *Domains & Routes*, or as a `routes` entry with `custom_domain: true`. This requires the **zone to be on Cloudflare DNS**. Set `PUBLIC_ORIGIN` to match: a learned origin is the first one seen and would otherwise stay on the `workers.dev` address.

### Passkeys and the site's address

The owner signs in with `ADMIN_PASSWORD`. Everyone else is a **person** added under **Settings → People**, who gets a one-time invite link (valid a week) and creates a **passkey** with it — Face ID, a fingerprint or the device's screen lock, kept in iCloud Keychain or Google Password Manager so a new phone has it too. On a computer, the browser's sign-in sheet offers **Scan QR code**: the phone's camera reads it and the phone's passkey signs the computer in (Bluetooth must be on, on both). Once signed in, **Account → Add a passkey on this device** gives a personal computer its own passkey (Touch ID, Windows Hello) so it signs in by itself; on a shared computer, keep using the phone. A lost device is a new invite link; removing a person ends their sessions on their next click.

**A passkey belongs to the address it was made on.** It is created for the dashboard's hostname (`PUBLIC_ORIGIN`, or the `workers.dev` address the owner first opened it on), and phones will only offer it on that same hostname. So if a ward moves from `ward-app.<them>.workers.dev` to its own domain, every person needs a new invite link and a new passkey; set `PUBLIC_ORIGIN` to the new address first. The owner password keeps working throughout, which is how the owner sends those links.

**Testing passkeys locally.** Use `localhost`, never `127.0.0.1` — browsers refuse passkeys on a bare IP address — and make sure `PUBLIC_ORIGIN` is either unset or the exact address in the browser, since it decides the hostname a passkey is tied to. Password managers that provide passkeys through their browser extension (Bitwarden, for one) require **https** even on `localhost`, and hand the request back to the browser otherwise, so to test with one, use an https tunnel (ngrok or similar) with `PUBLIC_ORIGIN` set to the tunnel's address. A tunnel whose address changes on restart strands the passkeys made for the old one; make a fresh invite link.

### The cron trigger

`triggers.crons` is `* * * * *` — every minute, **UTC** (Cloudflare cron is always UTC, and it ignores the `TZ` var). The weekly schedule is not expressed in the cron at all: each tick asks `uncoveredSlot()` whether the last occurrence in the configured timezone still has no send recorded against it, which stays true for 12 hours after it (so a skipped or delayed tick, or a busy queue, still covers the slot), and the occurrence's key is stored on the send so a trigger firing the same minute twice cannot send twice. A weekly cron would be wrong here: a send is delivered a chunk at a time, so the runtime has to come back until the queue is empty.

### Free-plan notes

- **CPU:** documented as 10 ms per invocation on the free plan, with some tolerance for occasional overruns. One push encryption (VAPID signature + RFC 8291) measures about 0.25 ms on a laptop and **0.6–1.1 ms on Workers in production**; one measured invocation ran 500 encryptions to completion. A drain handles `PUSH_CHUNK_SIZE` = 12 subscribers — at or a little over the nominal budget — and the cron comes back a minute later for the next 12, so a ward-sized list drains in a handful of ticks. Measure on your own account before raising it.
- **Subrequests:** 50 per invocation on the free plan. Each delivery is one `fetch`, so 12 leaves room for the D1 queries around it.
- **Invocations:** the free plan's daily allowance is 100,000. A minute tick is 1,440 of them, and a tick with an empty queue does one cheap `COUNT(*)` and returns — the rest is left for visitors.

### Backups (D1)

The dashboard's backup (see [3a](#3a-backups)) — a ZIP with every image, or the JSON data alone — is the portable dump and works identically here. Cloudflare also keeps **D1 Time Travel**: any point in the last 30 days (7 on the Workers Free plan) can be restored with `npx wrangler d1 time-travel restore ward-app --timestamp=<ISO8601>` (`… time-travel info` shows the available bookmarks). Time Travel covers "someone deleted the announcements"; the ZIP backup covers "the whole account went away".

### Running it locally

```bash
cp .dev.vars.example .dev.vars   # the Workers equivalent of .env; git-ignored
npm run vapid                    # optional: prints a key pair to paste into .dev.vars (unset, one is generated and stored)
npm run cf:dev                   # wrangler dev on http://localhost:8787
```

`wrangler dev` uses a local SQLite file under `.wrangler/` in place of D1. Note that **push subscription requires HTTPS or `localhost`** — local dev can subscribe, but testing on a phone needs the deployed URL. `npm run test:worker` runs the HTTP suites (access gate, attachments, programs, hardening, roles, passkeys, ward settings) against `wrangler dev` on a throwaway database, then the attachment suite again with an R2 bucket bound.

## 2b. Hosting many wards (one deployment)

One Worker (`src/host.ts`) serves every ward at `<ward>.<your domain>`: each ward is its own SQLite Durable Object (its own database, its own alarm for the weekly send), images share one R2 bucket under a per-ward prefix, and a registry decides which hostnames are wards. It is a **separate Worker** from any single-ward deployment and needs **Workers Paid** ($5/month): a ward finishes a send inside one request or alarm, which the free plan's 10 ms of CPU cannot do.

**Deploy day, step by step.** Steps 4, 5 and 7 are what keep an existing single-ward deployment on the same domain (say `myward.example.org`) safe; do not skip or reorder them.

*Before*
1. Workers Paid on the account.
2. On the commit being deployed: `npm test`, `npm run test:worker` and `npm run test:host` all pass.
3. Copy `wrangler.host.example.jsonc` to `wrangler.host.production.jsonc` (git-ignored); put your domain in `routes` and `OPERATOR_HOST`. `npx wrangler deploy --dry-run --config wrangler.host.production.jsonc` must bundle cleanly (it uploads nothing).
4. **Fence off every existing subdomain.** List the zone's DNS records and note every hostname that already serves something (an existing ward's Custom Domain, `www`, …). Route Workers run *before* a Custom Domain Worker, so `*.example.org/*` would capture all of them. For each, add a route in the dashboard (Workers Routes → Add route) for `<that hostname>/*` with the Worker set to **None** — the more specific route wins, and the host never sees it.
5. Note what each fenced site looks like now: `curl -s https://myward.example.org/ | grep -o '<title>[^<]*'` prints its own title. (`/healthz` is no use here — the host answers it too.)
6. `npx wrangler r2 bucket create ward-host-images`; a proxied wildcard DNS record (`*`) — any target, since the host answers before Cloudflare looks for an origin, so an existing one can stay (Cloudflare advises against an `AAAA 100::` placeholder); `npx wrangler secret put ADMIN_PASSWORD --config wrangler.host.production.jsonc` — the operator password, a long passphrase (it opens every ward). Shorter than 16 characters and the host refuses it: no operator tools and no owner sign-in, with an error in the log saying so.

*Deploy*
7. `npm run host:deploy`, then **at once** repeat step 5's check for every fenced site: the same title as before. If any shows "There is no ward at this address", remove the host's route (Workers → `ward-host` → Domains & Routes) and look at step 4 again before anything else.

*Verify*
8. `curl -s https://no-such-ward.example.org/` says "There is no ward at this address": the host is live. Sign in at `https://<OPERATOR_HOST>/`.
9. Add a test ward for yourself (`test.example.org`, you as its first admin), open the invite on a phone, install the app, turn notifications on, and send a manual notification from its dashboard — it should arrive. Set its schedule a few minutes ahead and watch the operator page: the next alarm moves to that minute and, after it, "last notification" shows the weekly send.
10. Delete the test ward when done (export first if you want to look at it).

*Rolling back*
- To take the host off the domain, remove its route: traffic stops reaching it within seconds and every fenced site is untouched either way. The Worker and its data stay.
- **Never `wrangler delete` the host once a real ward is on it**: that deletes every ward's Durable Object, which is all of its data. Export each ward from the operator page first.
- A bad release is rolled back like any Worker (Deployments → rollback). Migrations only ever add, so the previous code still runs against a ward that already migrated.

**Running it.** Sign in at `https://<OPERATOR_HOST>/` with the operator password: add a ward (its subdomain of `WARD_DOMAIN` — which is also its permanent id — its name, and its first admin's name; you get an invite link to send them), and see every ward's schema version, subscriber count, next alarm and last notification. From there: a fresh admin invite (the way back in when a ward's admins lose their passkeys), suspend/resume (a suspended ward answers nobody and sends no notifications), move to a new hostname (everyone must be re-invited — passkeys belong to an address — and members reinstall from the new address), export the ward (its full backup ZIP — [below](#exporting-a-hosted-ward)), import a backup into it ([below](#importing-a-backup-into-a-hosted-ward)), and delete (type the id to confirm; export first — it cannot be undone). The same actions are an API at `/__operator/…` with `Authorization: Bearer <password>` for scripts. A hosted ward has **no "Owner sign-in"**: its sign-in page offers passkeys only, and the operator password is no use there. To get into a ward yourself, mint an admin invite for yourself from the operator page — you then appear in that ward's People list, as anyone with access should. (`WARD_OWNER_SIGNIN=on` would put the operator password on every ward's sign-in page instead; only the test configs set it.) `IMAGE_QUOTA_MB` caps each ward's image storage. Three vars from the table in [§ 2](#2-environment-variables) are **per ward, and ignored host-wide**: `PUBLIC_ORIGIN` (each ward's address is its hostname), `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (each ward keeps the pair in its own database, or the one given to Import Backup). Set on the host they would apply to every ward at once — one address for every ward's passkeys and notification links, one key signing every ward's sends — so a ward boots without them and the log says which were ignored. `VAPID_SUBJECT` is host-wide, on purpose: it is the operator's contact address. A delete that fails half-way (the ward's data gone, the registry not yet answering) is finished by deleting again. Every hosted ward has the generic meetinghouse icon: `npm run host:deploy` builds with `ICON_MASK=chapel-mask.png`, whatever `art/icon.local.json` selects for this machine's own single-ward deployment.

**What a ward's owner is told:** their ward is run by its people — admins and editors with passkeys, as on any deployment — and the platform operator can see and restore everything in it. Say so plainly when offering hosting; it is the price of not running it themselves. [Hosting and privacy](#hosting-and-privacy), below, is the longer version to point them at.

### Importing a backup into a hosted ward

**Import Backup**, on a ward's line on the operator page, replaces everything in that ward with a backup: the ZIP from **Export** or from any ward's **Download Backup (ZIP)** (data and images), or a `backup.json` (data only). It is how a hosted ward is restored after a disaster, and how an existing ward moves onto the host. The dialog asks for:

- **The file.** The page unpacks a ZIP itself and sends the data first, then the images in batches of about 2 MB, with a running count (restored / already there / failed) and a **Retry** for any that failed. Importing the same ZIP again is safe: images already in the ward are skipped.
- **Push keys** (optional, under *Keep members' notifications working*). Every subscription was made against the old deployment's VAPID public key. A backup or export made **on this host** carries the ward's pair sealed under the host's `BACKUP_SEAL_KEY`, and the import opens it: nothing to paste. A backup from **another deployment** carries its pair sealed under *that* deployment's key (which this host cannot open — the summary says *locked*), or no pair at all (a deployment with no `BACKUP_SEAL_KEY` leaves it out, since with the subscriber list beside it a plaintext pair would let the file push to every member). For those, the pair comes from the old database (`SELECT value FROM settings WHERE key = 'vapid_keys'`, through `wrangler d1 execute` or `sqlite3`; the value is `{"publicKey","privateKey"}`) or, for a deployment that pinned `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` as secrets, from wherever they were generated (Cloudflare never shows a secret back). Without them the ward keeps its own pair, or makes one: installed apps re-subscribe against it on their next launch, and anyone else has to turn notifications on again (the summary warns). The pair is checked: well-formed, and the private key must belong to the public one. A contact (`VAPID_SUBJECT`) may be given with them; a host-wide `VAPID_SUBJECT` var still wins.
- **The ward's address, typed out**, to confirm. Nothing is undone by a second import; export the ward first if it holds anything worth keeping.

The import runs inside the ward as one transaction: a file that is not a backup, a backup from a newer version of the app, a mismatched key pair, or a row that fails part-way through writing leaves the ward exactly as it was. Two things in the file are not taken as they are: a subscription that is not at a real push service (an IP address, plain http, a hand-edited row) is left out and counted in the warnings, since the host would otherwise send to it every week; and, as on any restore, the send queue starts empty and the weekly catch-up starts from the import, so nothing goes out twice. Afterwards the page shows the rows per table, any columns dropped (`subscriptions.label`, from an early version), the schema version it migrated from, where the push keys came from — and, for a sealed backup, whether this host's key opened them — (with the first characters of the public key, to compare with the old site's `/api/vapid-public-key`), the people and passkeys, and warnings: a backup from a **different address** (passkeys belong to the address they were made on, so its people need new invites), subscribers without their keys, no people at all (use **Invite admin**), or no access code (the old gate was off). The ward keeps its own place on the host, its name and timezone when the backup has none, and its address; a learned address from elsewhere in the backup is dropped. Members keep their sign-in, installed apps keep their device tokens and the QR posters keep working, because the codes, tokens and cookie key all travel in the backup. The same import is an API for scripts: `POST /__operator/wards/<id>/import` with `{ backup, confirm, vapidPublicKey?, vapidPrivateKey?, vapidSubject? }`, then `POST /__operator/wards/<id>/images` with `{ images: [{ key, data }] }` (base64), at most 12 MB and 8 MB a request.

### Exporting a hosted ward

**Export**, on a ward's line, downloads the ward's **full backup** — the same ZIP its own **Download Backup (ZIP)** makes (`backup.json`, every image, `manifest.json`), built in your browser by the same code — named `<ward id>-backup-<date>.zip`. It needs nobody in the ward to sign in, so it is the disaster-recovery copy even for a ward whose admins are locked out, and it is exactly what **Import Backup** takes. The line under the ward shows its progress ("Adding images… 9 of 24") and then what was saved; an image that could not be read does not stop it, but is named there and listed in the ZIP's `manifest.json`. **Data only (JSON)** beside it downloads just the JSON (`<ward id>-backup-<date>.json`), which Import Backup also takes but restores no images from.

For scripts, `GET /__operator/wards/<id>/export` stays the **data only** (the JSON), and `GET /__operator/wards/<id>/images/<key>` returns one image (the keys are the `attachments` rows' `key`); together they are what the page zips.

### Moving an existing ward onto the host

For a single-ward deployment moving to the host at the **same hostname**, so members, installed apps and (where it has them) passkeys carry on:

1. Do the deploy-day steps above with the ward's hostname **fenced off** (step 4), so the old Worker keeps serving it throughout.
2. On the operator page, add the ward with that hostname and the ward's name, home-screen name and timezone (a backup from an early version has none of them), and no first admin: the import replaces the people anyway.
3. Ask the ward's editors to pause, then on the old dashboard download the backup — the ZIP, or, from a version without the ZIP, the JSON plus its images (the old site serves each at `/images/<key>`; put them into a ZIP of the same layout).
4. **Import Backup** into the new ward, with the old push keys (read out of the old database, or the secrets — see above; the old deployment's backup seals them under a key this host does not have). Check the summary: the subscriber count, the push key's first characters against the old site's, every image restored.
5. If the backup has no people, mint yourself an admin invite (**Invite admin**); it works once the hostname points at the host.
6. Move the hostname: remove its fence route (Workers Routes) so the host's wildcard route takes it, check it serves the ward, then remove the old Worker's Custom Domain or route for it (Workers → the old Worker → Domains & Routes). This switch is manual; nothing here changes routes.
7. Open the app on a phone that had it installed: it should open without the gate, with its images. Send a test notification from the hosted ward's dashboard.

To roll back, put the fence route back: traffic returns to the old Worker and its database, which the import never touched (anything written on the host meanwhile stays there). Delete the old Worker and its database only once the ward has run on the host for a while.

### Hosting and privacy

What a ward on a shared host (`oneward.org`, or anyone else's deployment of `src/host.ts`) should know before it says yes. An operator offering hosting can point wards here.

**What is stored for each ward**, in the ward's own Durable Object database and, for images, under the ward's prefix in the host's R2 bucket:

- Announcements, resource pages and their images, as the ward's editors wrote them.
- **Sacrament meeting programs**, which name the people speaking, praying and taking part — sometimes youth and children — and any image attached to one (often a photo of the printed program). A program is deleted on the retention clock the ward sets (90 days unless an admin changes *Delete programs after* under Ward Settings), images and all.
- **The people who run the ward**: each admin's and editor's name and role, and for each passkey its public key, its signature counter and the kind of device it was made on ("iPhone", "Mac"). No passwords, email addresses or phone numbers: a passkey's private half never leaves the person's device.
- **Members' notification subscriptions**: for each phone or browser that turned notifications on, the push service's address for it, the keys to encrypt to it, and its browser's user-agent string. Members are not stored by name.
- **The access gate**: the current and retired access codes, the member cookie's signing key, and the tokens behind installed apps, member invites and emailed links.
- The send history (every notification's title and text), the schedule and the ward's settings, including the push keys the ward sends with.

**Who can see it.** The ward's own admins see what the dashboard shows. **The operator sees everything**: the operator page exports any ward's full backup — the push keys and the people's session key included — without anyone in the ward signing in, can import over it, and can mint themselves an admin invite (they then appear in the ward's People list). That is what makes a ward recoverable when its admins lose their passkeys, and it is the trust a ward gives the host; see [What a ward's owner is told](#2b-hosting-many-wards-one-deployment).

**Cloudflare** runs the host and stores the data, as the operator's processor. The host's config turns Cloudflare's Workers Logs on (`"observability"` in `wrangler.host.example.jsonc`), so the operator can see each request's metadata — the address and path asked for, when, and request headers that include the visitor's IP address — alongside every line the app logs, which names the ward. The app keeps the access code out of its own log lines, but an installed app's first request after a cold launch carries its device token in `?code=` (see [Security notes for reviewers](ARCHITECTURE.md#security-notes-for-reviewers)), and Cloudflare's request log records the address as it was asked for.

**When a ward is deleted** (operator page → Delete), the ward's object empties its whole database (`deleteAll()`), every image under its prefix in R2 is deleted (with no bucket bound, the images were in the database and went with it), and a minute later the prefix is swept again for an upload that was still on its way; then the ward's line leaves the registry, and its id and address are free. What can outlast that:

- **Exports the operator took** (`<ward>-backup-<date>.zip` or `.json`) are files on the operator's own computer, and theirs to delete.
- **Backups the ward's admins downloaded** are theirs to delete.
- **Cloudflare's own copies**: request logs for as long as Cloudflare keeps them, and whatever point-in-time history Cloudflare holds for Durable Object storage, which only the operator's account can reach.
- **Notifications already delivered** stay on members' phones; their subscriptions simply stop receiving.

**Leaving.** An admin downloads the ward's backup (Settings → Backup → **Download Backup (ZIP)**) and restores it into a deployment of the ward's own — [the Deploy button](#the-deploy-to-cloudflare-button), then [Restoring a backup](#restoring-a-backup). The access codes, device tokens and member cookie key travel in it, so members stay signed in and printed QR codes keep working once the ward's address points at the new deployment. Passkeys belong to the address: at the same address they carry on, at a new one every person needs a new invite. The push keys travel in the backup too, but sealed under the host's `BACKUP_SEAL_KEY`: restored **on the same host** (into the same ward after a mishap, or into another ward there) the backup keeps every subscription, but a deployment of the ward's own cannot open them, so it sends with a pair of its own and installed apps re-subscribe on their next launch. To keep every subscription as it was, ask the operator for the ward's pair — their **Export** carries it sealed under the host's key, which only they can open (`node scripts/db-restore.mjs <export> --seal-key …` prints the `vapid_keys` row in the clear) — and pin it as `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` on the new deployment, or hand it to [Import Backup](#importing-a-backup-into-a-hosted-ward) on another host. Then ask the operator to delete the ward.

**No affiliation, no guarantee.** A shared host is not run by The Church of Jesus Christ of Latter-day Saints, and `oneward.org` comes with no service-level agreement: no promised uptime, support hours or notice before changes. A ward that needs those runs its own copy.

## 3. Persistent volume (Node only)

Keep the SQLite database on storage that outlives the container or the deploy: with Docker, a named volume or a host directory mounted at `/data` (the image already sets `DATABASE_PATH=/data/app.db`); without Docker, a directory outside the checkout, with `DATABASE_PATH` pointing into it. **Without this, all subscriptions are lost on every deploy.**

Images attached to announcements live on the same volume by default (`/data/uploads`, derived from `DATABASE_PATH`), so nothing extra is needed — but if you point `UPLOADS_PATH` somewhere else, that somewhere else has to be persistent too, and backed up separately.

## 3a. Backups

The database is the **subscription list** — lose it and the whole ward must re-onboard by hand. Back it up. Uploaded images live beside it (objects in R2, files under `UPLOADS_PATH` on Node, or rows in D1 on a Worker with no bucket); losing them costs a few flyers, not the ward. The dashboard's backup below holds both, on every deployment; the `sqlite3` recipes after it are for the Node path only (on Workers, D1 Time Travel plays that role — see [Backups (D1)](#backups-d1)). **Do not just `cp app.db`**: the Node app runs in WAL mode, so recent writes may still be sitting in `app.db-wal` and a bare file copy silently misses them.

**Quick manual backup (no shell access needed):** Settings → Backup → **Download Backup (ZIP)**, for an admin. The browser fetches the data (`GET /admin/backup.json`) and every image (`/images/<key>`), shows its progress ("Adding images… 12 of 42"), and saves one ZIP:

| In the ZIP | What it is |
| --- | --- |
| `backup.json` | Every row of every table (announcements, programs, pages, people and passkeys, subscriptions, settings, send log, access codes and tokens), apart from the session-signing key and pending dashboard invites, with the push keys sealed or left out (see below) — byte for byte what the **Data only (JSON)** link beside the button downloads |
| `images/<key>` | Every image an `attachments` row names, under its own storage key |
| `manifest.json` | Format version, the app's schema version, when and from which address, the image count and bytes, and any image that could not be downloaded (with why) |

The ZIP is put together in the browser (`public/backup-zip.js`, `public/zip.js`) rather than on the server because a free-plan Worker has about 10 ms of CPU per request, far too little to checksum megabytes of images. It is stored, not compressed: the images are JPEG/PNG/WebP/GIF already, and were downscaled on upload, so a ward with a few hundred images makes a file of tens of megabytes. An image that fails to download does not stop the backup; it is named on the page and in `manifest.json`. The data is a *logical* dump, not a file-level snapshot: the tables are read one after another, so a write landing mid-download could in principle split across tables — irrelevant at ward scale, but the reason it doesn't replace the cron job below on Node. It is also the only backup shape that works on every storage backend (a SQLite file image is meaningless on Cloudflare D1). For durable, unattended protection still schedule the cron job below (a button someone has to remember to click is not a backup strategy).

⚠️ **Keep the backup as safe as the access codes.** It holds the codes, the member cookie-signing key, every device token, the people's passkey records and the subscriber list — every member's push address with its encryption keys. Anyone with the file can let themselves into the ward's member page. Two things keep it *only* that: it is no way into the dashboard, because the key that signs people's sessions and any pending dashboard invites are omitted (after a restore everyone signs in again, with their passkey or the owner with the password, and a pending invite is sent again); and it cannot send notifications, because the **push keys** (the VAPID pair the app generated) never travel in the clear — with the subscriber rows beside it, a plaintext pair would let a leaked file's holder push to every member's phone, and the only remedy would be every member re-subscribing. Instead the pair travels **sealed** (AES-256-GCM, `src/seal.ts`) under a secret only the deployment holds, `BACKUP_SEAL_KEY` — 32 random bytes, base64url; `npm run vapid` prints one, set it like the other secrets and never change it — as a `vapid_keys_sealed` row in place of `vapid_keys`. A restore on a deployment with that key (the same one, or a fresh one given the same secret) opens it and the ward sends as before; a backup from another deployment cannot be opened — the restore says *locked* and keeps the pair already in the database — so supply the keys on import, or on a single-ward deployment pin them as `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`. With **no `BACKUP_SEAL_KEY` set** the pair is simply left out, and the price is paid on a restore to a *fresh* database: the ward sends with the pair it minted when the site was first opened, installed apps notice the changed key and re-subscribe on their next launch, and anyone who never installed the app turns notifications on again. A restore over the same database keeps its pair in every case, so nothing changes for anyone. The dashboard's Backup card says which applies to this deployment. The many-ward host's operator export seals the pair the same way under the host's key (in the clear only on a host with none) and keeps the session key and invites, so moving a ward on the host signs no one out and re-subscribes no one; it deserves the same care as the platform password.

For automated/host-side backups, use SQLite's own backup, which captures a consistent snapshot including the WAL:

```bash
# Host-side; DATA is the host directory that is mounted at /data (or holds DATABASE_PATH):
DATA=/srv/ward-announcements/data
mkdir -p "$DATA/backups"
sqlite3 "$DATA/app.db" ".backup '$DATA/backups/app-$(date +%F).db'"
# equivalently:
sqlite3 "$DATA/app.db" "VACUUM INTO '$DATA/backups/app-$(date +%F).db'"
```

If `sqlite3` isn't on the host, run it inside the container instead (only if the image has it):

```bash
docker exec ward-announcements sh -c \
  "sqlite3 /data/app.db \".backup '/data/backups/app-\$(date +%F).db'\""
```

Automate with a daily host cron entry:

```cron
# 03:15 daily: snapshot the DB, then keep only the last 7
15 3 * * * DATA=/srv/ward-announcements/data; mkdir -p "$DATA/backups"; sqlite3 "$DATA/app.db" ".backup '$DATA/backups/app-$(date +\%F).db'"; ls -t "$DATA/backups"/app-*.db | tail -n +8 | xargs -r rm -f
```

(`ls -t | tail -n +8 | xargs rm -f` keeps the 7 newest and deletes the rest.)

**Restore:** stop the app, replace `app.db` with the backup, remove the stale `app.db-wal` and `app.db-shm` files, then start the app again:

```bash
docker stop ward-announcements
cp "$DATA/backups/app-2026-07-04.db" "$DATA/app.db"
rm -f "$DATA/app.db-wal" "$DATA/app.db-shm"
docker start ward-announcements
```

### Restoring a backup

Either file restores anywhere — that is why the data is JSON and not a SQLite file image — but something has to turn it back into statements. On a single-ward deployment, `scripts/db-restore.mjs` does (on the many-ward host, use the operator page's [Import Backup](#importing-a-backup-into-a-hosted-ward) instead):

```bash
node scripts/db-restore.mjs ward-announcements-backup-2026-09-10.zip > restore.sql    # data + images
node scripts/db-restore.mjs ward-announcements-backup-2026-09-10.json > restore.sql   # data only
BACKUP_SEAL_KEY=… node scripts/db-restore.mjs backup.zip > restore.sql               # with the push keys (or --seal-key …)
```

It prints SQL and touches no database, so read the file before you apply it. Give it the deployment's `BACKUP_SEAL_KEY` (the environment variable, or `--seal-key`; it reads no `.env`) and the push keys sealed in the backup are restored with everything else; without it, or with another deployment's key, the terminal says the pair stayed *locked* and the pair already in the database is kept — on a fresh database, the one minted when the site was first opened. `db-restore.mjs` skips a backup image whose extension does not match an allowed image type, and `/images/:key` always serves the type its extension implies. It is a **replace**, not a merge: every table is emptied and refilled, with ids preserved (they are load-bearing — `attachments.owner_id` points at an announcement, a program or a page). A table the backup predates is left empty. A column this version no longer has (`subscriptions.label`, in a backup from an early version) is dropped and named on the terminal; a table it does not have, or a backup from a newer version of the app, is refused rather than partly restored. A backup is a moment in the past, so the sending state is not restored as it was: the send queue is left empty, a send that was still going is marked finished, and the weekly catch-up starts from the restore — so nothing the backup was mid-way through sending, and no digest that already went out today, is sent again. The rules live in `src/restore.ts`, which the host's import shares.

Three settings get special treatment. The many-ward host's own (`host_ward_*`) belong to where the backup was made and are left out. The learned address (`public_origin`) is kept, since restoring a ward over itself is the usual case, but the script prints it: if this deployment lives somewhere else and sets no `PUBLIC_ORIGIN`, clear it after the restore (`DELETE FROM settings WHERE key = 'public_origin';`), or every notification and share link points at the old site. And the **push keys** (`vapid_keys`) are the one row a restore does not empty when the backup has none to give — because it was made with no `BACKUP_SEAL_KEY`, or its sealed pair did not open here — so a ward restored over itself keeps the pair its subscribers were made with. Restored onto a fresh database (the reset → open → restore order below) with the backup's seal key, the pair is the backup's; without it, the one the app minted at that first open: installed apps re-subscribe against it on their next launch, others turn notifications on again. A backup whose pair opens (or an operator's export from a host with no seal key, which carries it in the clear) replaces the target's.

The tables have to exist first. Nothing in the script creates them: `initDb()` is the only thing that should ever write the schema, and it runs before the first *database query* an isolate makes. So the order after a wipe is **reset → load the app's home page → restore**. It has to be a page that reads the database — `/` does (the gate check queries it), but `/healthz` deliberately does not, so pinging health checks alone leaves you restoring into tables that aren't there yet.

`ward-app` below is the database the Deploy button's template creates; with your own config, use the `database_name` it names (the D1 page of the Cloudflare dashboard lists it too).

```bash
# Workers / D1
npx wrangler d1 execute ward-app --remote --file=restore.sql

# Node — stop the app first, and keep a copy of app.db in case the restore is the mistake.
# Wrapped in one transaction with -bail, so a bad row leaves the database as it was: a plain
# `sqlite3 app.db < restore.sql` carries on past an error and leaves tables half-restored.
docker stop ward-announcements
(echo "BEGIN;"; cat restore.sql; echo "COMMIT;") | sqlite3 -bail /data/app.db
docker start ward-announcements
```

**The images**, from a ZIP, are written to a folder (`<backup name>-images/`, or `--images-dir DIR`) — only names the restored `attachments` rows use — and the script prints the command for each place a deployment keeps them:

```bash
# Workers with an R2 bucket: the object name is the key itself (no prefix on a single-ward Worker)
for f in ward-announcements-backup-2026-09-10-images/*; do
  npx wrangler r2 object put "<bucket>/$(basename "$f")" --file "$f" --remote
done

# Workers with no bucket (images in D1): put them in the SQL instead, as file_chunks rows
node scripts/db-restore.mjs ward-announcements-backup-2026-09-10.zip --d1-images > restore.sql

# Node / Docker: into UPLOADS_PATH (by default uploads/ beside the database; /data/uploads in Docker)
cp ward-announcements-backup-2026-09-10-images/* /data/uploads/
```

The R2 objects need no content type: the app recovers it from the key's extension. A restore never empties `file_chunks` (the image bytes of a Worker with no bucket), so restoring the *data* over a database that still has its images keeps them. A data-only JSON restore over a database whose images are gone leaves `attachments` rows pointing at keys that 404: the text is fine, its thumbnails are broken — restore from the ZIP, or delete those images from the editor.

### Resetting the database

Starting over — a test deployment being handed to a real ward, say. `scripts/db-reset.mjs` prints one `DROP TABLE` per table in the schema (both scripts read the table list out of `src/db.ts`, so neither can fall behind a table added later):

```bash
node scripts/db-reset.mjs > reset.sql
npx wrangler d1 execute ward-app --remote --file=reset.sql   # Workers / D1
sqlite3 /data/app.db < reset.sql                                       # Node, app stopped
```

Then load the app's home page (again, not `/healthz` — it touches no database): the app finds no `schema_version`, recreates the schema, and seeds its sample announcements. Dropping rather than deleting rows is deliberate — the `AUTOINCREMENT` counters restart at 1, which `DELETE FROM` would leave where they were.

On Workers, redeploy (`npm run cf:deploy`, or `npm run deploy` for the template) after the reset and again after the restore: each isolate checks the schema and reads the ward's push keys, address and settings once, when it starts (`initCore` in `src/worker.ts`), so a warm one keeps the previous ones — and skips recreating the schema — until it is recycled, which a deploy does at once.

**What a reset actually costs**, since none of it comes back:

- **Every subscriber.** They must each re-enable notifications on their own device; you cannot do it for them. This is the expensive one.
- **The access gate.** Codes, the cookie-signing secret and every device token go, so every member needs the new link, from the fresh code the app mints when it next starts.
- **Announcements, programs and the send history**, and the schedule and weekly-message settings.
- **Not the images.** Objects in R2 (or files under `UPLOADS_PATH`) survive with no rows left to name them. They are unreachable and harmless — the keys are unguessable random names — but if you want them gone, empty the bucket or the directory in the same sitting.

Take a backup first even if you mean to throw it away: the dashboard's Backup button costs one click, and it is the only thing standing between a mistyped database name and the subscriber list.

## 3b. Member access gate (always on)

The page is always behind the gate: a ward's names and plans are not for search engines or the open web, so there is no switch to make it public. The first code is minted when the app first starts (`ensureAccessCode`, at boot on every runtime), so a new deployment is gated from its first request and the owner finds the share link and QR waiting in the dashboard's **Access Code** card (Settings). Everything else about the gate is managed from there. Set `PUBLIC_ORIGIN` (or let the dashboard learn it) so the share link is absolute.

The dashboard then shows a **share link** like `https://announcements.example.org/#code=XYZ`, plus a QR code downloadable as SVG (for printing) or PNG (for a flyer, a slide or a text), and a ready-made **printable flyer** (PDF) with the install steps for iPhone and Android around that QR, half-letter or two to a letter sheet. Distribute it however you like. Opening it sets a long-lived (5-year, sliding) cookie, so members unlock once per device and stay unlocked as long as they keep opening it. Anyone without it gets a soft "members only" page (no content); the API returns 401.

The code rides in the URL **fragment** (`#code=`) rather than a query param, so it never reaches a proxy's or server's access log and isn't picked up when a chat app fetches a pasted link to build a preview.

**Rotating.** Use **Issue a New Code** in the dashboard — no redeploy needed. Rotation mints a new code and puts the old one on a grace clock (a week by default; 30 days, 6 months, a year, immediately or indefinitely are the other choices) so QR posters already on a bulletin board keep working while you replace them. Rotating is safe for members: **nobody who already opened the app loses access**, including people who scanned years ago and installed devices whose cold-launch credential is a separate per-device token. Make it routine, every few months, and reprint the posted QR codes each time: a link passed further than intended then stops working within months instead of staying good for years, which is what keeps the sign-out choices on the same form rarely needed. Rotate at once if the code turns up somewhere public. The grace chosen when issuing a new code is also the ceiling for every older retired code still in its grace — "Stop it immediately" ends them all, and a later "Indefinitely" never extends an older code.

**Evicting readers.** Rotating closes the door going forward but leaves everyone already inside, by design. The same form has a second choice, **Who is signed out**, for when that is not enough. *Everyone who used a browser* ends every member's saved sign-in at once, so a stranger or a bot that opened the link in a browser is out, and so is every member on a phone browser, who needs the new link again; installed apps quietly let themselves back in on next launch (their cold-launch credential is a separate per-device token), so members who added the app notice nothing. *Everyone, including installed apps* is the last resort, for when you suspect unwanted people or bots have the installed app itself: it also cancels every installed app's device token, every member invite link and every emailed app link, so nobody gets back in without the new code. Every member pays for that one, so a lost phone on its own is not a reason — the phone's own lock is the control there, and the program is only readable in its window. Either choice stops the old code immediately, whatever grace was picked, since a retired code still working would let the evicted party straight back in. An installed app cannot scan a QR or reach an address bar: it opens to its locked page, which offers a **Paste your ward link** field — so send the new link by text or email, and tell members to paste it there (or delete the app and add it again from Safari).

**Wording and invite length.** The locked page's message and how long member invite links last (1–365 days) are both set in the dashboard under **Gate Page Wording & Invite Length**.

One thing you must re-issue after rotating, before the old code's grace runs out (a week unless you chose otherwise): **printed QR codes** — download the new PNG (or print new flyers) from the dashboard.

**Members sharing it on.** The announcements page has a **Share With Someone** button that mints a one-off link (`#i=…`) with its own QR, good for the invite length set in the dashboard (30 days by default, under **Gate Page Wording & Invite Length**) with unlimited uses in that window — enough to seed a whole class or a conference. This deliberately does *not* hand out the shared code, so a screenshot of someone's share sheet expires on its own rather than staying live until your next rotation.

It's still a shared deterrent, not per-person auth — a code shared with the whole ward will leak eventually, so keep genuinely sensitive details off the page.

**A link in the weekly email.** The dashboard's **Preview** (Content tab) has an *Include a link to the app* checkbox. Ticked, the copied text and the saved PDF end, under a rule, with a line inviting the reader to the app, linked with its own 14-day credential (the PDF adds a QR of the same link for anyone reading on a computer). It is never the shared code, so old emails stop working by themselves, and ticking it again the same week reuses the same link. The line says which day the link lapses.

⚠️ The database holds the access codes, the invite/device tokens, and the member cookie secret, so **the dashboard's backup (ZIP or JSON) is sensitive** — treat a backup file the way you'd treat the codes themselves.

## 4. Node or Docker on your own server

A single Node process serving plain HTTP on `PORT`, with SQLite on disk: the same server `npm run dev` runs locally. It suits a ward that already has a server to put it on. The Workers path is the primary one only because it needs no server, no storage and no certificate of its own.

### Build & run

**With Docker.** The included `Dockerfile` builds TypeScript and runs `node dist/server.js` on port 3000 as the unprivileged `node` user (uid and gid 1000), declares `/data` as a volume with `DATABASE_PATH=/data/app.db`, and has a health check against `/healthz`. `.env` is not copied into the image (`.dockerignore` keeps it, `.dev.vars`, the `*.production.jsonc` configs and `art/icon.local.json` out of the build), so pass the settings at run time. The icons show the generic meetinghouse unless you build with your own building's mask in `art/` (see [art/README.md](../art/README.md)): `docker build --build-arg ICON_MASK=my-building.png -t ward-announcements .`

```bash
docker build -t ward-announcements .
docker run -d --name ward-announcements --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -v ward-announcements-data:/data \
  --env-file .env ward-announcements
```

Publishing the port on `127.0.0.1` keeps it reachable from the server itself and not from the internet, which `TRUST_PROXY` depends on (below). If the proxy runs in a container of its own, put both on one Docker network and publish no port instead.

A new named volume takes its ownership from the image, so the app can write it from the start. A **host directory** mounted at `/data` (`-v /srv/ward-announcements/data:/data`) keeps the host's ownership instead: make it writable by uid 1000 first (`sudo chown -R 1000:1000 /srv/ward-announcements/data`).

**Files written into `/data` from outside the container** — the host-side `sqlite3` restore or a `cp` into `uploads/` below, run with `sudo` — are root's: hand them back (`chown -R 1000:1000`) before starting the container, or the app cannot write them and stops at startup with `attempt to write a readonly database` in `docker logs`. (`docker exec` runs as `node` already.)

**Without Docker.** `npm ci && npm run build`, then `node dist/server.js` under whatever keeps processes running on the server. It reads `.env` from its working directory (template: `.env.node.example`). Use npm 12 or later: `better-sqlite3` ships prebuilt binaries, but the npm that Node 22 bundles tries to compile it anyway (the note in the `Dockerfile` explains).

Either way, put the database on persistent storage ([step 3](#3-persistent-volume-node-only)), and point an uptime monitor at `/healthz` if you like: on Node the server only starts listening once the database has opened and its schema is current.

### HTTPS in front

Push needs HTTPS and the app speaks plain HTTP, so put it behind a reverse proxy that terminates HTTPS and forwards to `PORT`. It needs no special headers or rules, but it must serve the app at the site's **root** path, so the service worker's scope (`/`) covers the whole app. Then set:

- `NODE_ENV=production`, which marks cookies `Secure` and makes `PUBLIC_ORIGIN` required.
- `PUBLIC_ORIGIN` to the https address members will use, exactly (see [Verify after deploy](#5-verify-after-deploy)). The app only ever sees plain HTTP from the proxy, so unlike on Workers it cannot learn the address itself.
- `TRUST_PROXY=1` (`true` and `yes` work too). The rate limits on sign-in, the access code and subscribing are keyed on the client's address. Unset, that is the socket's address, which behind a proxy is the proxy's own, so every member shares one budget. Set, it is the **last** `X-Forwarded-For` entry, the one the proxy appended (the socket's address when the header is missing); never the first, which is whatever the client wrote. That is right when one proxy that appends to `X-Forwarded-For` sits in front and the app's port cannot be reached any other way. With a second proxy in the chain, the last entry is the outer proxy's address and members share a budget again; with the port open to the internet, anyone can send their own header and get a fresh budget per request.

## 5. Verify after deploy

0. Confirm `PUBLIC_ORIGIN` is byte-identical to the host members will install from (apex vs `www`, no trailing slash). The access cookie is host-only and the notification's target URL is built from it, so a mismatch sends a tapped notification to a different cookie jar — the gate page.
1. Visit the HTTPS URL on a phone; confirm the page loads over TLS.
2. **iOS:** Share → Add to Home Screen, open the installed app, tap **Enable Notifications**, accept the prompt.
3. **Android/desktop:** install via the browser prompt (or just use the tab), tap **Enable Notifications**.
4. Open `/admin`, log in with `ADMIN_PASSWORD`, send a test push, and confirm it arrives on each device. Note any delay (iOS may coalesce/delay — minutes is normal, not "broken").
5. **On Workers**, a manual send delivers its first chunk inside the request and the rest on the following cron ticks; the flash message says how many are still going out, and the send history fills in its recipient count when the queue empties.

## Notes / gotchas

- If you rotate VAPID keys or change the origin, every subscription must be re-created: installed apps do it themselves on their next launch, everyone else turns notifications on again. A restore onto a fresh database is a rotation unless the backup's sealed pair opens there (the same `BACKUP_SEAL_KEY`); without one, the dashboard's backup carries no keys.
- The service worker and `manifest.webmanifest` must be served from the site root (same origin) — they are.
- **Workers:** `/healthz` answers 200 *before* the Worker boots, on purpose, so it cannot tell a broken deployment (a missing secret, an unbound D1) from a healthy one — every real route would be on a 503 while it stayed green. Point an uptime monitor at `/healthz?deep=1` instead: that one awaits config, the D1 driver and the schema, and returns 503 with the failure logged.
- **Workers:** `run_worker_first` must stay on in `wrangler.jsonc`. Without it the assets binding answers first and the member access gate never sees the request.
- **Workers:** the rate limits are counted per isolate, so they are a speed bump rather than a global budget. Per minute and per client: owner sign-in 5, passkey sign-in and registration 30 for the challenge and 10 for the answer, `/api/access` and `/api/subscribe` 300, `/api/invite` and `/api/unsubscribe` 60; on the host, the operator's API 60 (of which 5 may carry a wrong password; past that every request waits out the minute, the right password too) and its sign-in 5. The member-facing ones are deliberately loose (300 a minute per IP) because a chapel on one wifi network is one IP, and the gate page treats a 429 as "try again shortly" rather than as a bad link.
- **Node:** `better-sqlite3` is a native module. The Docker image installs prebuilt binaries; if a build ever fails, add `build-essential python3` before `npm ci`.
