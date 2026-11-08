# Changelog

What changes from one version to the next, newest first, in the style of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The app has no numbered releases yet; each heading is a point on `main`.

**If your ward deployed with the Deploy to Cloudflare button**, your copy of the code is a fork that does not update itself. Someone comfortable with GitHub merges this repository's `main` into it; Cloudflare then redeploys, and the database migrates itself on the next visit. Read the entries since your last merge first: anything a ward must do by hand is written there.

**Schema changes** are flagged here with the new `SCHEMA_VERSION` (`src/db.ts`). Migrations only ever add, and any older database is brought up to date, so skipping releases is safe; but code older than the schema it runs against is not, so roll back with a database backup to hand.

## Unreleased

First public release. Everything described in [README.md](./README.md), [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) is in it; `SCHEMA_VERSION` is 12.

### Fixed

- **A used invite link now says so.** The passkey invite page looked the same for a week after the link had been redeemed, and pressing Create Passkey again — the next Sunday, from the same bookmark — produced only a terse refusal, or on the phone that had redeemed it the browser's own. The page now checks the link as it loads: one already used says when, one expired or replaced says that, and each offers the sign-in page, where the passkey the link made gets them in.

### Added

- **PDF attachments.** An announcement, a page or a program can carry a PDF (up to 5 MB) beside its images. The dashboard draws its first page as the thumbnail members see; tapping it opens the PDF in the app's own viewer, with a Done button (the phone's viewer would replace an iPhone home-screen app with the PDF, with no way back) and, for an announcement's or a page's, a share button to save or print it. A program's PDF link carries a token good until the program's window closes, and the dashboard's links to private PDFs one good for twelve hours, so a link opened outside the page that has the cookie still works. In the announcements preview and copy a PDF shows as its thumbnail, linked to it; Save as PDF prints a one-page PDF beside its announcement like an image, and a longer one the same way or, with "Print multi-page PDFs in full at the end" ticked, every page after the rest. **Schema:** `SCHEMA_VERSION` 12 adds `attachments.thumb_key` and `attachments.page_count`; a deployment on 10 migrates itself on the next visit, with nothing to do by hand.
