# Contributing

Thanks for helping. This is a small app for wards, and changes are welcome when they keep it simple and reliable on members' phones.

## Before you start

Read [AGENTS.md](AGENTS.md): what the app is, its constraints, its conventions and which tests to run for which files. It is written for people and coding agents alike. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how it is built and why, and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) how it runs.

For anything larger than a fix, open a **Proposal** issue first and say what you have in mind.

## Making a change

```bash
npm install
cp .env.node.example .env   # set ADMIN_PASSWORD
npm run dev                 # http://localhost:3000, dashboard at /admin
npm test                    # before every pull request
```

`npm test` must pass. Some files also need the Workers suites (`npm run test:worker`, `npm run test:host`); [the table in AGENTS.md](AGENTS.md#tests) says which. Neither needs a Cloudflare account.

- Match the code around your change, comments included: they say *why*.
- A schema change is an additive migration in `src/db.ts`, and a line in [CHANGELOG.md](CHANGELOG.md).
- Anything a member sees on screen: look at it on a phone, or run `npm run screenshots`, before saying it works.

## Keep wards' secrets out of issues

Issues and pull requests are public and permanent. **Never paste** into one:

- a share link or anything with `#code=`, `#i=`, `?code=` or `#t=` in it, or a QR code from a real ward;
- a backup (`*-backup-*.zip` or `.json`), `restore.sql`, or anything from the database;
- log lines from a real deployment (they name wards and can carry addresses and push endpoints);
- members' names, or a real program.

Reproduce the problem on your own copy with a made-up ward instead. If you already pasted something, delete it and tell the ward to issue a new code (Settings → Access Code).

A security problem goes through [SECURITY.md](SECURITY.md), not an issue.
