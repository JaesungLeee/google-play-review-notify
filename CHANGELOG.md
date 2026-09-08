# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `doctor` command: checks Node version, config (sources, events, channel routing), Gmail
  credentials and recent Play emails, Play API access per app, store listing reachability,
  channel URLs and the state store, and prints a fix hint for every problem. Read-only.
- Reusable workflow `.github/workflows/notify.yml` (`workflow_call`) bundling permissions,
  checkout and the Action; the example consumer workflow now uses it.

## [0.1.2] - 2026-09-08

### Fixed

- The published CLI reported `0.1.0` for `--version` and in User-Agent headers: the version is
  now inlined at build time instead of read from npm's environment. CI verifies
  `dist/cli.js --version` against `package.json`.

## [0.1.1] - 2026-09-08

### Added

- Korean email rule set (`rules/email/ko.json`), bundled with the English one. Play Console
  policy emails share one subject for rejections and deadline warnings, so `REJECTED` is now
  decided by the body line `앱 상태: 거부됨` / `App Status: Rejected`.
- Store listing source: detects `LIVE` for the production track when a listing goes from
  404 to 200 (first release) or its "Updated on" date changes. Google sends no approval email
  and the Play API reports a release as `completed` while still under review, so this is the
  signal that a release actually shipped.
- Play Developer API source: detects `SUBMITTED` when a new versionCode appears on a
  configured track. Event ids match `emit`, so CI-emitted events never duplicate.
- `auth gmail` command: loopback OAuth flow that prints a `gmail.readonly` refresh token.
- Guides: `docs/gmail-oauth.md`, `docs/play-api-setup.md`.

### Changed

- Default sender allowlist now includes `no-reply-googleplay-developer@google.com`, the
  address policy and review notices actually come from.
- English rule set reworked around real emails; over-broad `Policy` / `Warning` subject
  matches removed.

### Fixed

- Reason extraction for non-ASCII headings (`발견된 문제: ...`): JavaScript `\b` never
  matches after Korean text.

## [0.1.0] - 2026-09-08

### Added

- Initial release: core pipeline, Gmail email source, Slack / Discord / generic webhook
  notifiers, file / GitHub Actions cache state stores, CLI, GitHub Action.
