# Changelog

What changes from one version to the next, newest first, in the style of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The app has no numbered releases yet; each heading is a point on `main`.

**If your ward deployed with the Deploy to Cloudflare button**, your copy of the code is a fork that does not update itself. Someone comfortable with GitHub merges this repository's `main` into it; Cloudflare then redeploys, and the database migrates itself on the next visit. Read the entries since your last merge first: anything a ward must do by hand is written there.

**Schema changes** are flagged here with the new `SCHEMA_VERSION` (`src/db.ts`). Migrations only ever add, and any older database is brought up to date, so skipping releases is safe; but code older than the schema it runs against is not, so roll back with a database backup to hand.

## Unreleased

First public release. Everything described in [README.md](./README.md), [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) is in it; `SCHEMA_VERSION` is 10.
