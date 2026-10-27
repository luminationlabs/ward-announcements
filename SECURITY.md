# Security

## Supported versions

Only the `main` branch is supported. There are no release branches, and fixes are not backported. A ward that deployed with the Deploy to Cloudflare button runs its own copy of the code and has to merge updates into it by hand; [CHANGELOG.md](CHANGELOG.md) says which updates matter.

## Reporting a problem

Please report a security problem privately, not in a public issue, a pull request or a discussion.

- **Preferred:** GitHub's private vulnerability reporting, at [Security → Report a vulnerability](https://github.com/luminationlabs/ward-announcements/security/advisories/new). The report is seen only by the maintainers until a fix is published.
- **Or by email:** [round.desk4716@fastmail.com](mailto:round.desk4716@fastmail.com), the same address wards use to ask for hosting.

Say what you found, how to reproduce it, and what someone could do with it. Please leave out real access codes, share links (`#code=…`, `#i=…`), device tokens, backups and log lines from a real ward: a made-up ward on your own copy (`npm run dev`) shows the problem just as well.

This is a small project with no fixed response time, but every report is read, and you will be told what is happening with yours.

## In scope

- The app in this repository, on any of its three runtimes: the single-ward Worker (`src/worker.ts`), the many-ward host (`src/host.ts`, `src/operator.ts`) and the Node server (`src/server.ts`, the `Dockerfile`).
- Anything that gets past the member access gate, shows a sacrament meeting program outside its window, opens the dashboard without a passkey or the owner password, lets an editor do what only an admin may, lets one hosted ward read or change another, or sends notifications on a ward's behalf.
- The hosted service at `oneward.org`, for problems in this code. Please do not test against real wards there: make your own copy, or ask for a test ward.

## Out of scope

- Cloudflare's platform, the push services (Apple, Google, Mozilla) and browsers, except where this app uses them wrongly.
- A deployment's own configuration: a weak `ADMIN_PASSWORD`, a reverse proxy without HTTPS, a public QR poster.
- Denial of service by volume, and the rate limits being per isolate on Workers (a known limit, below).
- Anything listed as an accepted risk in the security notes below.

## How it is meant to be secure

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the design: the [member access gate](docs/ARCHITECTURE.md#member-access-gate), [admin sign-in and roles](docs/ARCHITECTURE.md#http-endpoints), the [response headers and Content Security Policy](docs/ARCHITECTURE.md#http-endpoints), and the [many-ward host](docs/ARCHITECTURE.md#the-many-ward-host). [Security notes for reviewers](docs/ARCHITECTURE.md#security-notes-for-reviewers) lists the risks that are known and accepted, so a report can start from there. What a ward on the hosted service should know is in [Hosting and privacy](docs/DEPLOYMENT.md#hosting-and-privacy).
