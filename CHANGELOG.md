# Changelog

What changes from one version to the next, newest first, in the style of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The app has no numbered releases yet; each heading is a point on `main`.

**If your ward deployed with the Deploy to Cloudflare button**, your copy of the code is a fork that does not update itself. Someone comfortable with GitHub merges this repository's `main` into it; Cloudflare then redeploys, and the database migrates itself on the next visit. Read the entries since your last merge first: anything a ward must do by hand is written there.

**Schema changes** are flagged here with the new `SCHEMA_VERSION` (`src/db.ts`). Migrations only ever add, and any older database is brought up to date, so skipping releases is safe; but code older than the schema it runs against is not, so roll back with a database backup to hand.

## Unreleased

First public release. Everything described in [README.md](./README.md), [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) is in it; `SCHEMA_VERSION` is 11.

### Added

- **PDF attachments.** An announcement, a page or a program can carry a PDF (up to 5 MB) beside its images. The dashboard draws its first page as the thumbnail members see; tapping it opens the PDF in the app's own viewer, with a Done button (the phone's viewer would replace an iPhone home-screen app with the PDF, with no way back) and, for an announcement's or a page's, a share button to save or print it. A program's PDF link carries a token good until the program's window closes, and the dashboard's links to private PDFs one good for twelve hours, so a link opened outside the page that has the cookie still works. The announcements copy and Save as PDF leave PDFs out. **Schema:** `SCHEMA_VERSION` 11 adds `attachments.thumb_key`; a deployment on 10 migrates itself on the next visit, with nothing to do by hand.
