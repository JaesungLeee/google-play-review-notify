# google-play-review-notify

[![CI](https://github.com/JaesungLeee/google-play-review-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/JaesungLeee/google-play-review-notify/actions/workflows/ci.yml)
[![CodeQL](https://github.com/JaesungLeee/google-play-review-notify/actions/workflows/codeql.yml/badge.svg)](https://github.com/JaesungLeee/google-play-review-notify/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/play-review-notify)](https://www.npmjs.com/package/play-review-notify)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Get a Slack, Discord, or webhook message when Google Play **rejects** your app, when a release
**goes live**, or when Google sends a **policy notice**. Runs as a GitHub Action or a CLI, needs no
server, and works for any app in any Play Console account.

한국어 문서: [README.ko.md](README.ko.md)

## Why this exists

Google Play tells you about review outcomes in exactly two places: the Play Console UI and the
developer account's inbox. There is no webhook, and the Publishing API has no "in review /
approved / rejected" state. This tool watches the signals that _do_ exist and turns them into
normalized events:

| Event            | Detected from                                   | How                                                                                                   |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `REJECTED`       | Gmail (Play Console policy email)               | Body line `App Status: Rejected` / `앱 상태: 거부됨`; the reason is extracted                         |
| `POLICY_WARNING` | Gmail                                           | "Action required" notices with a deadline, target API level warnings                                  |
| `SUBMITTED`      | Play Developer API                              | A new versionCode appears on a configured track                                                       |
| `LIVE`           | Public store listing                            | The listing goes from 404 to 200 (first release) or its "Updated on" date changes                     |
| `REMOVED`, `SUSPENDED`, `APPROVED` | Gmail                         | Rule sets exist but are unverified drafts: Google normally sends **no approval email** for updates    |
| `UNKNOWN_NOTICE` | Gmail                                           | A Play email the rules could not classify (off by default; turn on to catch new email formats)        |

Everything is idempotent: each event has a stable id, state is persisted between runs, and the
first run only records a baseline without notifying.

> The detection rules were validated against real Play Console emails and Play API responses.
> The resulting decision table and known limits, including managed publishing, are in
> [docs/design.md](docs/design.md#what-each-signal-can-and-cannot-say).

## Quick start: GitHub Action

1. Create the three Gmail secrets by following [docs/gmail-oauth.md](docs/gmail-oauth.md)
   (one-time, about 10 minutes). Optionally add a Play service account with
   [docs/play-api-setup.md](docs/play-api-setup.md) to get `SUBMITTED` events.
2. Add `play-review-notify.yml` to your repository. `npx play-review-notify init` writes it and
   the workflow below after a few questions; or start from
   [examples/play-review-notify.yml](examples/play-review-notify.yml).
3. Add a workflow:

```yaml
name: Play review notify
on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch:

jobs:
  notify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: write # state is kept in the Actions cache
    steps:
      - uses: actions/checkout@v4
      - uses: JaesungLeee/google-play-review-notify@v1
        with:
          config-path: play-review-notify.yml
        env:
          GMAIL_CLIENT_ID: ${{ secrets.GMAIL_CLIENT_ID }}
          GMAIL_CLIENT_SECRET: ${{ secrets.GMAIL_CLIENT_SECRET }}
          GMAIL_REFRESH_TOKEN: ${{ secrets.GMAIL_REFRESH_TOKEN }}
          PLAY_SERVICE_ACCOUNT_JSON: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

Or call the reusable workflow, which bundles the permissions, checkout and the Action:

```yaml
jobs:
  notify:
    permissions:
      contents: read
      actions: write # a called workflow cannot request more than the caller grants
    uses: JaesungLeee/google-play-review-notify/.github/workflows/notify.yml@v1
    with:
      config-path: play-review-notify.yml
    secrets: inherit
```

The Action also accepts the main settings as inputs when you do not want a config file
(`packages`, `gmail-*`, `play-service-account-json`, `slack-webhook-url`, `discord-webhook-url`,
`webhook-url`, `webhook-secret`, `state-store`, `dry-run`, `emit-event`) and exposes `events`,
`events-count`, and `has-rejection` as outputs for later steps. See [action.yml](action.yml).

GitHub's schedule trigger runs at most every 5 minutes and may be delayed. If you need faster
delivery, run the CLI from a cron job.

## Quick start: CLI

```bash
npm i -g play-review-notify                       # or use npx play-review-notify ...
play-review-notify init                            # asks a few questions, writes play-review-notify.yml

export GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... # docs/gmail-oauth.md
play-review-notify auth gmail                      # browser consent → prints GMAIL_REFRESH_TOKEN
export GMAIL_REFRESH_TOKEN=... SLACK_WEBHOOK_URL=...

play-review-notify doctor                          # verifies credentials and config, explains what to fix
play-review-notify test-notify                     # sends a sample REJECTED to your channels
play-review-notify run --dry-run --verbose         # shows what would be detected, sends nothing
play-review-notify run                             # first run records a baseline, later runs notify
```

`gprn` is a short alias for `play-review-notify`. Schedule `run` with cron, a CI job, or an n8n
Schedule Trigger; state lives in `.play-review-notify/state.json` by default.

| Command               | Purpose                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `init`                | Generate the config (and a GitHub workflow) from a few questions   |
| `run`                 | Poll all enabled sources once, notify, save state, exit            |
| `auth gmail`          | One-time OAuth flow that prints a `gmail.readonly` refresh token   |
| `doctor`              | Check config, credentials, sources, channels and state, with fixes |
| `test-notify`         | Send a sample event to the configured channels                     |
| `emit`                | Emit an event from a pipeline, e.g. `SUBMITTED` right after upload |
| `state show \| reset` | Inspect or clear the persisted state                               |

Exit codes: `0` ok, `1` configuration or auth error, `2` a source failed (notifications still
sent), `3` a notification failed. `--json` switches to structured output.

**Language.** In a terminal the CLI first asks whether to continue in English or Korean (Enter
picks the system locale's language). Skip the question with `--lang en|ko` or
`PLAY_REVIEW_NOTIFY_LANG=ko`; outside a terminal, with `--json`, or with `--version` there is no
question and the output is English. Generated files, JSON output, and core log lines stay English
in every language.

## Configuration

Secrets are never written to the file; use `${ENV_VAR}` references.

A JSON Schema is published at
[schemas/config.schema.json](schemas/config.schema.json). Put this comment on the first line of
your YAML to get completion, hover help, and typo checks in VS Code (with the YAML extension),
JetBrains IDEs, and other editors that honour it:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/JaesungLeee/google-play-review-notify/main/schemas/config.schema.json
version: 1

apps:
  - packageName: com.example.app
    name: 'Example App' # used to match emails that omit the package name
    tracks: [production]
    channels: [release-slack] # per-app routing; falls back to defaultChannels

sources:
  email:
    enabled: true
    auth:
      clientId: ${GMAIL_CLIENT_ID}
      clientSecret: ${GMAIL_CLIENT_SECRET}
      refreshToken: ${GMAIL_REFRESH_TOKEN}
    lookbackHours: 24 # window used on the first run and after state loss
    # senderAllowlist: [...]      # defaults cover Google Play's sender addresses
    # rules: [./my-rules.json]    # extend or replace the bundled rule sets
  playApi:
    enabled: true
    serviceAccountJson: ${PLAY_SERVICE_ACCOUNT_JSON}
  storeListing:
    enabled: true
    locale: en
    country: US

events: # defaults: everything on except SUBMITTED and UNKNOWN_NOTICE
  REJECTED: { enabled: true, mentions: ['<!channel>'] }
  SUBMITTED: { enabled: true }
  LIVE: { enabled: true, mergeInto: APPROVED }

channels:
  release-slack: { type: slack, webhookUrl: ${SLACK_WEBHOOK_URL} }
  ops-discord: { type: discord, webhookUrl: ${DISCORD_WEBHOOK_URL} }
  n8n:
    type: webhook # any HTTP receiver: n8n, Make, Zapier, your own server
    url: ${N8N_WEBHOOK_URL}
    secret: ${N8N_WEBHOOK_SECRET} # HMAC-SHA256 signature header (optional)
    batch: false
defaultChannels: [release-slack]

templates: # Mustache-style overrides per event type
  REJECTED: |
    :x: *{{appName}}* ({{packageName}}) v{{versionName}} was rejected.
    Reason: {{reason}}
    {{consoleUrl}}

stateStore:
  type: file # file | github-cache | none | custom
  path: .play-review-notify/state.json

includeReason: true
maxRetries: 3
```

- **Channels**: `slack` (Incoming Webhook, Block Kit), `discord` (webhook embed), `webhook`
  (JSON payload with `X-Play-Review-Event`, `X-Play-Review-Timestamp`, and
  `X-Play-Review-Signature: sha256=HMAC(secret, timestamp + "." + body)` headers; `batch: true`
  sends one array per run). The payload is described by
  [schemas/webhook-payload.schema.json](schemas/webhook-payload.schema.json); importable n8n
  workflows are in [examples/n8n](examples/n8n/README.md).
- **State stores**: `file` (CLI default), `github-cache` (Action default; entries expire after 7
  days without access, which is fine for any schedule shorter than that), `none` (lookback window
  only), `custom` (a local module exporting a `StateStore`).
- **Templates** receive every event field plus `app.*` from the config.

## How the signals work, honestly

- **Rejections** always arrive by email from `no-reply-googleplay-developer@google.com`. The subject
  is the same for rejections and deadline warnings, so classification uses the body.
- **Approval** of an update produces no email. The Play Developer API reports a release as
  `completed` the moment it is submitted, even while it is under review. The only proof that a
  release reached users is the public store page, which is what the `storeListing` source watches.
  This only covers the production track.
- **Managed publishing**: the store page changes only after you press "Publish", so the
  "approved, waiting to publish" moment is not observable by any source.
- **Email language** follows your Play Console language. Rule sets ship for English and Korean;
  contributions for other languages are welcome (see below).

## Docs

- [Gmail setup (OAuth refresh token)](docs/gmail-oauth.md) · [한국어](docs/gmail-oauth.ko.md)
- [Play Developer API setup (service account)](docs/play-api-setup.md) · [한국어](docs/play-api-setup.ko.md)
- [Design: event model, signals, pipeline, extension points](docs/design.md)
- [Integrating with n8n](examples/n8n/README.md)
- [Changelog](CHANGELOG.md)

## Contributing

Bug reports, new email formats, and rule sets for other languages are the most valuable
contributions. If a Play email was not classified, enable `UNKNOWN_NOTICE` to see it, then open a
"Unrecognized Play email" issue with the masked subject and body. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and how rule sets are tested.

Security issues: see [SECURITY.md](SECURITY.md). Please do not open public issues for them.

## Privacy and permissions

- Gmail access uses the read-only scope `gmail.readonly` only. Emails are never stored; the state
  file keeps message ids and a timestamp, and notifications contain only the extracted fields
  (app, version, reason capped at `reasonMaxLength`).
- The Play service account needs only "View app information (read-only)". The read-only edit that
  is opened to list tracks is always discarded.
- The store listing source makes one unauthenticated request per app per run with an explicit
  User-Agent.
- Secrets referenced in the config are redacted from logs.

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test
npm run build            # dist/ (CLI, library) and dist/action/index.js (committed Action bundle)
npm run cli -- --help
```

## License

[Apache-2.0](LICENSE)
