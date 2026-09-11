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

Google Play has no webhook for review outcomes. The Play Developer API does expose the review
state of each release (`applications.tracks.releases.list`, `releaseLifecycleState`), and the
developer inbox carries what the API leaves out: policy warnings and the reason for a rejection.
This tool polls both and turns them into normalized events:

| Event                | Detected from      | How                                                                                             |
| -------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `PENDING_SUBMISSION` | Play Developer API | A release is created but not yet sent for review (off by default)                               |
| `SUBMITTED`          | Play Developer API | The release enters review (off by default)                                                      |
| `APPROVED`           | Play Developer API | The release passed review and waits for you to press Publish (managed publishing)               |
| `REJECTED`           | Play Developer API | The release was not approved. The Play Console email then adds the reason as a follow-up        |
| `LIVE`               | Play Developer API | The release is available to users on its track, production or not                               |
| `POLICY_WARNING`     | Gmail              | "Action required" notices with a deadline, target API level warnings                            |

Everything is idempotent: each event has a stable id, state is persisted between runs, and the
first run only records a baseline without notifying.

> The transition table behind the API events and the email rules are in
> [docs/design.md](docs/design.md#what-each-signal-can-and-cannot-say). The release lifecycle
> endpoint is new (spring 2026); its edge cases are still being confirmed on real accounts and are
> listed there.

## Quick start: GitHub Action

1. Create a Play service account with [docs/play-api-setup.md](docs/play-api-setup.md)
   (read-only, about 10 minutes): it provides the release events. Optionally add the three Gmail
   secrets by following [docs/gmail-oauth.md](docs/gmail-oauth.md) for policy warnings and
   rejection reasons.
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

events: # defaults: everything on except PENDING_SUBMISSION and SUBMITTED
  REJECTED: { enabled: true, mentions: ['<!channel>'], reasonFollowUp: true }
  SUBMITTED: { enabled: true }
  LIVE: { enabled: true, mergeInto: APPROVED } # one message per release instead of approved + live

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

- **Release states** come from `applications.tracks.releases.list`, whose
  `releaseLifecycleState` moves through `NOT_SENT_FOR_REVIEW → IN_REVIEW → APPROVED_NOT_PUBLISHED
  | NOT_APPROVED → PUBLISHED`. The adapter remembers the last state of every release and emits one
  event per state entered. Polling runs every few minutes, so a transition can be skipped: a
  release seen `IN_REVIEW` and next `PUBLISHED` produces `APPROVED` and `LIVE` together.
- **Managed publishing on**: `APPROVED` fires when the release reaches "Ready to publish";
  `LIVE` fires after you press Publish. **Off**: approval publishes immediately, so both usually
  arrive in the same run (merge them with `LIVE: { mergeInto: APPROVED }` if one message is enough).
- **Rejections** are reported by the API without a reason. The reason arrives by email from
  `no-reply-googleplay-developer@google.com`, usually minutes later, and is sent as a follow-up
  to the same rejection (`reasonFollowUp: false` turns that off). The subject is the same for
  rejections and deadline warnings, so classification uses the body.
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
contributions. If a Play email was not classified, run with `--verbose` (unmatched emails are
logged with their subject), then open a "Unrecognized Play email" issue with the masked subject
and body. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and how rule sets are tested.

Security issues: see [SECURITY.md](SECURITY.md). Please do not open public issues for them.

## Privacy and permissions

- Gmail access uses the read-only scope `gmail.readonly` only. Emails are never stored; the state
  file keeps message ids and a timestamp, and notifications contain only the extracted fields
  (app, version, reason capped at `reasonMaxLength`).
- The Play service account needs only "View app information (read-only)". Only
  `applications.tracks.releases.list` is called; no edit is ever opened.
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
