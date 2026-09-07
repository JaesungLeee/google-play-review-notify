# PRD: Google Play Review Notify

> A reusable workflow that detects Google Play app review outcomes (approved, rejected, and more) and notifies Slack or Discord.

| Item | Value |
| --- | --- |
| Document version | 1.0 |
| Date | 2026-09-07 |
| Status | Approved (2026-09-07) |
| Primary language | Korean ([PRD_ko.md](./PRD_ko.md) is the source of truth; this is the English translation) |

---

## 1. Background and Problem

When an app (or update) is submitted to Google Play Console, the review outcome is surfaced only in the Console UI and in emails sent to the developer account. Teams run into the following problems.

- Someone has to keep opening Play Console to learn the result.
- Rejection emails land in one person's inbox, so the team hears about it late.
- CI/CD automates uploads, but "approved and live" is still confirmed by a human.
- Every project writes its own monitoring script, duplicating maintenance.

**Official constraint**: the Google Play Developer Publishing API exposes only `draft / inProgress / halted / completed` as release status. **There is no field for under review, approved, or rejected**, and rejection reasons are not available through the API. The reliable primary source of review outcomes is therefore the notification email Google sends to the developer account.

## 2. Goals

1. Detect Google Play review events (entered review, approved, rejected, policy warning, removal/suspension) without human intervention.
2. Deliver those events to Slack or Discord with minimal delay.
3. Ship it as a **generic workflow any project can adopt**.
   - GitHub Actions: one `uses:` line
   - CLI: run anywhere with `npx` (GitLab CI, Jenkins, server cron, etc.)
4. Separate detection sources, state storage, and notification channels behind plugin interfaces so each can be extended.

### Non-Goals

- Scraping or browser-automating the Play Console web UI (ToS risk, brittle)
- Uploading builds or creating releases (covered by Fastlane, gradle-play-publisher, etc.)
- App Store Connect (iOS) support. The adapter design allows it later, but it is out of scope for v1.
- User review (ratings/comments) notifications. Different domain.
- A long-running server or daemon. Scheduling is delegated to cron or GitHub schedule triggers.

## 3. Users and Scenarios

| User | Need |
| --- | --- |
| Mobile app developer | See review results in the team channel right away, with the rejection reason |
| Release manager / QA | Track review status of several apps in one channel |
| DevOps | Adopt a standard action instead of per-repo scripts, keep secret handling simple |
| Open-source contributor | Add new channels (Teams, etc.) or new sources as adapters |

**Representative scenarios**

1. A developer uploads an AAB to the production track via CI. Ten minutes later the workflow detects a "submitted" event and posts to `#release`.
2. Two days later Google sends a rejection email. The next run parses it and posts a Discord message with the reason and a Play Console link.
3. After a fix and resubmission, the approval email triggers an "approved" notification, and once the store listing shows the new version a "live confirmed" notification follows.
4. Another team adds the same action to its repo, routing two apps to two different Slack channels.

## 4. Summary of Confirmed Design Decisions

| # | Decision | Choice | Notes |
| --- | --- | --- | --- |
| D1 | Detection | Email (primary) + Play API (secondary) + store listing (optional) | API has no review status |
| D2 | Runtime | GitHub Action and CLI | Core is a library; the Action is a thin wrapper |
| D3 | Stack | TypeScript / Node.js 20+ | Native Actions runtime, googleapis SDK |
| D4 | Channels | Slack and Discord via Incoming Webhooks, plus a generic HTTP webhook (for n8n and similar) | Extensible through a Notifier interface |
| D5 | State | Pluggable. Default: Actions Cache (Action) / local file (CLI) | No commit noise |
| D6 | Multiple apps | Supported, with per-app channel routing | |
| D7 | Event scope | Submitted, approved, rejected, plus policy warning, removal, suspension | Per-event on/off |
| D8 | Gmail auth | OAuth2 refresh token | `gmail.readonly` minimal scope |
| D9 | Messages | English default templates + user overrides | |
| D10 | Distribution | npm package + GitHub Marketplace action | semver, moving `v1` major tag |
| D11 | First run / lost state | Record a baseline only, send nothing | Email lookback window of N hours |
| D12 | External workflow integration | Generic webhook channel pushes events to an n8n Webhook Trigger (primary); self-hosted n8n may run the CLI via Execute Command (secondary) | n8n community node deferred to Phase 4 |

## 5. Functional Requirements

Requirement IDs follow `FR-<area>-<n>`. Priority is **P0 (must) / P1 (should) / P2 (could)**.

### 5.1 Event Model

Internally the system works on a source-agnostic, normalized `ReviewEvent`.

| Event type | Meaning | Main source | Priority |
| --- | --- | --- | --- |
| `SUBMITTED` | A new version entered review / pending review | Play API (new versionCode observed), explicit trigger | P1 |
| `APPROVED` | Review passed | Email | P0 |
| `REJECTED` | Review rejected (with reason) | Email | P0 |
| `LIVE` | Confirmed visible on the store | Store listing, Play API | P1 |
| `POLICY_WARNING` | Policy violation warning / action required | Email | P1 |
| `REMOVED` | App removed | Email | P1 |
| `SUSPENDED` | App or account suspended | Email | P1 |
| `UNKNOWN_NOTICE` | Definitely from Play, but could not be classified | Email | P2 |

Minimum `ReviewEvent` fields:

```ts
interface ReviewEvent {
  id: string;               // dedupe key, e.g. "email:<gmailMessageId>", "api:<pkg>:<track>:<versionCode>:LIVE"
  type: ReviewEventType;
  packageName: string | null; // null allowed when the email does not identify it; app name matching is attempted
  appName?: string;
  track?: string;           // production | beta | alpha | internal | custom
  versionCode?: string;
  versionName?: string;
  reason?: string;          // rejection / warning reason (plain text)
  consoleUrl?: string;      // Play Console deep link
  source: 'email' | 'play-api' | 'store-listing' | 'manual';
  confidence: 'high' | 'medium' | 'low';
  observedAt: string;       // ISO 8601
  raw?: unknown;            // debugging only, never included in notifications
}
```

- **FR-EVT-1 (P0)** Every source normalizes to `ReviewEvent`; source-specific data lives only in `raw`.
- **FR-EVT-2 (P0)** An event whose `id` is already recorded in the state store is never re-notified (idempotency).
- **FR-EVT-3 (P1)** When several sources report the same fact in one run (email `APPROVED` plus API `LIVE`), they remain separate events, but configuration can merge `LIVE` into `APPROVED`.
- **FR-EVT-4 (P0)** Per-event notification on/off. Defaults: `APPROVED, REJECTED, LIVE, POLICY_WARNING, REMOVED, SUSPENDED` on; `SUBMITTED, UNKNOWN_NOTICE` off.

### 5.2 Source Adapters

Common interface:

```ts
interface SourceAdapter {
  name: string;
  poll(ctx: PollContext, state: SourceState): Promise<{ events: ReviewEvent[]; nextState: SourceState }>;
}
```

#### 5.2.1 Email adapter (Gmail): primary signal

- **FR-SRC-EMAIL-1 (P0)** Calls the Gmail API with an OAuth2 refresh token; the only required scope is `https://www.googleapis.com/auth/gmail.readonly`.
- **FR-SRC-EMAIL-2 (P0)** Selects Play Console notifications using a sender allowlist (default: `googleplay-noreply@google.com`, `googleplay-developer-support@google.com`, domain `@google.com`) plus a subject/body rule set. The rule set must be extensible and overridable via configuration.
- **FR-SRC-EMAIL-3 (P0)** The rule set classifies emails into `APPROVED / REJECTED / POLICY_WARNING / REMOVED / SUSPENDED / UNKNOWN_NOTICE` and extracts app name, package name, version, and reason where possible.
- **FR-SRC-EMAIL-4 (P0)** On first run or after state loss, only messages within `lookbackHours` (default 24) are read, and the run records a baseline without sending notifications (D11).
- **FR-SRC-EMAIL-5 (P0)** Normal runs keep a processing watermark and a list of recently processed message IDs in state to prevent duplicates.
- **FR-SRC-EMAIL-6 (P1)** The built-in rule set is versioned inside the package (`rules/email/*.json`) so rule updates for new Google email formats ship without code changes.
- **FR-SRC-EMAIL-7 (P1)** Rules can be defined per locale because email language follows the Play Console language setting. The v1 default rule set covers English and Korean.
- **FR-SRC-EMAIL-8 (P1)** If the email lacks a package name, match against `apps[].name` (store display name). If matching fails, emit with `packageName: null` and route to the default channels.
- **FR-SRC-EMAIL-9 (P2)** Optionally allow the `gmail.modify` scope to label processed messages (off by default).
- **Security**: full email bodies are never written to logs, state, or notifications. Only the extracted reason text is used, with a length cap (default 1,000 characters).

#### 5.2.2 Play Developer API adapter: secondary signal

- **FR-SRC-API-1 (P1)** Authenticates to `androidpublisher` v3 with a service account JSON and reads releases for configured apps and tracks using a read-only flow (`edits.insert → edits.tracks.get → edits.delete`).
- **FR-SRC-API-2 (P1)** When a new `versionCode` appears on a track compared to the previous state, emit `SUBMITTED` (confidence: medium).
- **FR-SRC-API-3 (P1)** When a release is observed as `completed` or `inProgress` and either the store listing adapter or an email confirms approval, emit `LIVE`. The API alone does not emit `LIVE` by default; configuration may allow it (confidence: low).
- **FR-SRC-API-4 (P1)** When a previously observed versionCode disappears from a track with no higher version present, record a rejection candidate only. Do not notify without email confirmation (false-positive prevention).
- **FR-SRC-API-5 (P0)** The Phase 0 spike validates these inference rules against a real account and finalizes the decision table in the appendix. Until then the API adapter's rules are labeled "hypothesis".
- Required permission: the service account needs only the Play Console "View app information (read-only)" permission. No upload permission.

#### 5.2.3 Store listing adapter: optional

- **FR-SRC-STORE-1 (P2)** Fetches `https://play.google.com/store/apps/details?id=<pkg>&hl=<lang>&gl=<country>` without authentication and extracts the displayed version name and "Updated on" date.
- **FR-SRC-STORE-2 (P2)** Emits `LIVE` (confidence: medium) when either value changes from the previous state. If the version shows "Varies with device", only the updated date is used.
- **FR-SRC-STORE-3 (P2)** Off by default. Parsing failures (HTML changes, etc.) log a warning and the run continues. After `storeListing.failureThreshold` consecutive failures (default 5), a single warning notification is sent.
- **FR-SRC-STORE-4 (P2)** At most one request per app per run, with an explicit User-Agent.

#### 5.2.4 Manual / external trigger

- **FR-SRC-MANUAL-1 (P2)** A deploy pipeline can emit `SUBMITTED` directly right after upload via a CLI command (`emit --type SUBMITTED --package ... --version-code ...`) or an Action input (`emit-event`). Such events use the same `id` scheme as the API adapter's `SUBMITTED`, so they never duplicate.

### 5.3 State Store

```ts
interface StateStore {
  load(): Promise<State | null>;
  save(state: State): Promise<void>;
}
```

- **FR-STATE-1 (P0)** State is a single JSON document with a schema version field. Migrations run automatically on load.
- **FR-STATE-2 (P0)** Built-in implementations
  - `github-cache`: uses `@actions/cache`. Cache entries are immutable, so the save key is `<prefix>-<runId>-<attempt>` and restore uses `restore-keys: <prefix>-` to fetch the latest entry. The 7-day inactivity eviction is documented.
  - `file`: a local file at a configured path (default `.play-review-notify/state.json`). CLI default.
  - `none`: no persistence; operates on the email lookback window only (testing/debugging).
- **FR-STATE-3 (P1)** A git-commit store is not shipped in v1, but any user implementation of `StateStore` can be registered (`stateStore.module` loads a local module).
- **FR-STATE-4 (P0)** Because a notification may already be sent when a save fails, the order is: record the event id in state → save → send → record delivery result. Undelivered events are retried on later runs up to `maxRetries` (default 3).

### 5.4 Notification Channels

```ts
interface Notifier {
  name: string;
  send(message: RenderedMessage, target: ChannelTarget): Promise<void>;
}
```

- **FR-NOTIFY-1 (P0)** Slack Incoming Webhook: Block Kit message with per-event color/emoji, app name, package name, track, version, reason, and Play Console link.
- **FR-NOTIFY-2 (P0)** Discord Webhook: Embed with the same information.
- **FR-NOTIFY-3 (P0)** Channels are defined by name (`channels.<name>`) and can be routed per app and per event. Without routing, `defaultChannels` is used.
- **FR-NOTIFY-4 (P1)** Failed sends retry three times with exponential backoff and honor `Retry-After` on 429.
- **FR-NOTIFY-5 (P1)** In `dryRun` mode, rendered messages are printed to logs (and the Action job summary) but not sent.
- **FR-NOTIFY-6 (P1)** Mentions per event type (for example `<!channel>` or a Discord role id on `REJECTED`).
- **FR-NOTIFY-7 (P1)** A generic HTTP webhook channel (`type: webhook`) POSTs events as a normalized JSON payload (5.9.1) so any receiver can integrate: n8n, Make, Zapier, or a custom server.
- **FR-NOTIFY-8 (P1)** When `secret` is configured, the webhook channel sends an HMAC-SHA256 signature of the body in `X-Play-Review-Signature` and a replay-protection timestamp in `X-Play-Review-Timestamp`. Custom `headers` are also supported.
- **FR-NOTIFY-9 (P1)** The webhook channel sends one request per event by default; with `batch: true` all events from one run are sent as a single array.
- **FR-NOTIFY-10 (P2)** New channels (Teams, email, etc.) require only a new `Notifier` implementation.

### 5.5 Message Templates

- **FR-TPL-1 (P0)** Default English templates for each event type.
- **FR-TPL-2 (P0)** Per-event template overrides in configuration. The template engine uses a lightweight Mustache-compatible syntax; available variables are all `ReviewEvent` fields plus `app.*` (app metadata from configuration).
- **FR-TPL-3 (P1)** `includeReason` (default true) controls whether the reason is included.
- **FR-TPL-4 (P2)** Templates can also be referenced as files (`templates/*.md`).

### 5.6 Configuration

- **FR-CFG-1 (P0)** The configuration file is YAML (`play-review-notify.yml`) validated by a published JSON Schema.
- **FR-CFG-2 (P0)** Secrets (Gmail token, service account JSON, webhook URLs) are never written into the file; they are injected via environment variable references (`${ENV_NAME}`).
- **FR-CFG-3 (P0)** The GitHub Action accepts a config path and also exposes the main settings as individual inputs so it works without a file. Precedence: inputs > env > file.
- **FR-CFG-4 (P1)** `init` generates a configuration draft interactively.

Example configuration:

```yaml
version: 1

apps:
  - packageName: com.example.app
    name: "Example App"            # used to match emails that lack a package name
    tracks: [production, beta]
    channels: [release-slack]       # per-app routing (falls back to defaultChannels)
  - packageName: com.example.other
    name: "Other App"
    channels: [ops-discord]

sources:
  email:
    enabled: true
    auth:
      clientId: ${GMAIL_CLIENT_ID}
      clientSecret: ${GMAIL_CLIENT_SECRET}
      refreshToken: ${GMAIL_REFRESH_TOKEN}
    lookbackHours: 24
    senderAllowlist:
      - googleplay-noreply@google.com
      - googleplay-developer-support@google.com
    rules: builtin               # or an array of user rule file paths
  playApi:
    enabled: true
    serviceAccountJson: ${PLAY_SERVICE_ACCOUNT_JSON}
    emitLiveWithoutConfirmation: false
  storeListing:
    enabled: false
    locale: en
    country: US

events:
  SUBMITTED: { enabled: true }
  APPROVED:  { enabled: true }
  REJECTED:  { enabled: true, mentions: ["<!channel>"] }
  LIVE:      { enabled: true, mergeInto: APPROVED }
  POLICY_WARNING: { enabled: true }
  REMOVED:   { enabled: true }
  SUSPENDED: { enabled: true, mentions: ["<!channel>"] }
  UNKNOWN_NOTICE: { enabled: false }

channels:
  release-slack:
    type: slack
    webhookUrl: ${SLACK_WEBHOOK_URL}
  ops-discord:
    type: discord
    webhookUrl: ${DISCORD_WEBHOOK_URL}
  n8n:
    type: webhook                    # generic HTTP webhook (e.g. n8n Webhook Trigger)
    url: ${N8N_WEBHOOK_URL}
    secret: ${N8N_WEBHOOK_SECRET}    # HMAC-SHA256 signature (optional)
    batch: false
defaultChannels: [release-slack, n8n]

templates:
  REJECTED: |
    :x: *{{appName}}* ({{packageName}}) v{{versionName}} was rejected.
    Reason: {{reason}}
    {{consoleUrl}}

stateStore:
  type: file                   # file | github-cache | none | custom
  path: .play-review-notify/state.json

includeReason: true
```

### 5.7 CLI

Package name: `@jaesunglee/google-play-review-notify`, invoked as `npx @jaesunglee/google-play-review-notify <command>`

| Command | Description | Priority |
| --- | --- | --- |
| `run` | Poll once per configuration, notify, exit. Options `--dry-run`, `--config`, `--state-store` | P0 |
| `init` | Interactive configuration generator | P1 |
| `auth gmail` | Local browser OAuth consent, prints the refresh token and env setup instructions | P0 |
| `doctor` | Checks auth, permissions, webhook reachability, config schema; prints a result table | P1 |
| `test-notify` | Sends a sample event to channels | P1 |
| `emit` | Emit an event from outside (5.2.4) | P2 |
| `state show / reset` | Inspect or reset the current state | P1 |

- **FR-CLI-1 (P0)** Exit codes: 0 success, 1 config/auth error, 2 partial source failure (notifications still sent), 3 notification failure.
- **FR-CLI-2 (P0)** Human-readable logs by default, structured output with `--json`.
- **FR-CLI-3 (P1)** Runs on Node 20+ with minimal dependencies (googleapis, undici/fetch, yaml, zod or similar).

### 5.8 GitHub Action

- **FR-GHA-1 (P0)** `action.yml` uses `runs.using: node20` (no Docker). The bundled `dist/index.js` is committed.
- **FR-GHA-2 (P0)** Inputs: `config-path`, `gmail-client-id`, `gmail-client-secret`, `gmail-refresh-token`, `play-service-account-json`, `slack-webhook-url`, `discord-webhook-url`, `packages` (comma-separated, for file-less use), `state-store` (default `github-cache`), `dry-run`, `emit-event`.
- **FR-GHA-3 (P0)** Outputs: `events` (JSON array), `events-count`, `has-rejection` (boolean) for conditional follow-up steps.
- **FR-GHA-4 (P1)** Writes a results table to the GitHub Job Summary.
- **FR-GHA-5 (P1)** Ships a reusable workflow (`.github/workflows/notify.yml`, `workflow_call`) that encapsulates schedule, permissions, and cache setup.
- **FR-GHA-6 (P0)** Documents that the only required permissions are `actions: write` (cache save) and `contents: read`.

Usage example:

```yaml
name: Play review notify
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:

jobs:
  notify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: write
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

> GitHub schedule triggers have a 5-minute minimum interval and may be delayed. For tighter latency, run the CLI from a server cron every minute.

### 5.9 External Workflow Integration (n8n)

This tool focuses on detection. Post-processing after notification (ticket creation, documentation, multi-step approvals) can be delegated to a workflow automation tool such as n8n. Three integration modes are defined with their support level.

| Mode | Structure | Support level | Notes |
| --- | --- | --- | --- |
| A. Event push (primary) | This tool → `webhook` channel → n8n Webhook Trigger | P1, officially supported | Works on n8n Cloud and self-hosted |
| B. n8n runs the CLI | n8n Schedule Trigger → Execute Command (`npx @jaesunglee/google-play-review-notify run --json`) → n8n routing nodes | P2, docs and example provided | Execute Command is self-hosted only |
| C. n8n community node | `n8n-nodes-google-play-review-notify` wrapping the core library | Phase 4 candidate | Must reuse the core to avoid duplicating rule sets |

Re-implementing the whole pipeline with native n8n nodes is rejected because the email rule set and dedupe logic would be duplicated.

#### 5.9.1 Webhook event payload

- **FR-INTEG-1 (P1)** The payload is versioned JSON with a published JSON Schema (`schemas/webhook-event.v1.json`). Breaking changes bump `payloadVersion`.
- **FR-INTEG-2 (P1)** The `raw` field is never included. `reason` follows `includeReason` and the length cap.

```json
{
  "payloadVersion": 1,
  "sentAt": "2026-09-07T09:00:03Z",
  "event": {
    "id": "email:18f3...",
    "type": "REJECTED",
    "packageName": "com.example.app",
    "appName": "Example App",
    "track": "production",
    "versionCode": "1204",
    "versionName": "3.4.2",
    "reason": "The app's ...",
    "consoleUrl": "https://play.google.com/console/...",
    "source": "email",
    "confidence": "high",
    "observedAt": "2026-09-07T09:00:00Z"
  },
  "app": { "packageName": "com.example.app", "name": "Example App", "tracks": ["production"] },
  "run": { "id": "gha:1234567890", "dryRun": false }
}
```

Request headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `User-Agent` | `google-play-review-notify/<version>` |
| `X-Play-Review-Event` | Event type (e.g. `REJECTED`) |
| `X-Play-Review-Timestamp` | Unix epoch seconds |
| `X-Play-Review-Signature` | `sha256=<HMAC-SHA256(secret, timestamp + "." + body)>` (when a secret is set) |

- **FR-INTEG-3 (P1)** Any non-2xx response counts as a failure and follows the FR-NOTIFY-4 retry policy. Retries keep the same `event.id`, so receivers can deduplicate on it.

#### 5.9.2 Example n8n workflows

- **FR-INTEG-4 (P1)** Importable workflow JSON files are shipped under `examples/n8n/`.
  - `webhook-to-slack-discord.json`: Webhook Trigger → HMAC verification (Code node) → Switch on event type → Slack/Discord nodes
  - `rejected-to-jira.json`: creates a Jira issue for `REJECTED` events and posts the link back to the channel
  - `schedule-execute-cli.json` (mode B): Schedule Trigger → Execute Command → Split Out → notification nodes
- **FR-INTEG-5 (P2)** Docs describe the differences between n8n Cloud and self-hosted (Execute Command availability, test vs production webhook URLs).

#### 5.9.3 Notes for mode B

- Uses the CLI exit codes and `--json` output as-is (FR-CLI-1, FR-CLI-2). The top level of `--json` output is fixed as `{ "events": ReviewEvent[], "summary": {...} }`.
- State uses the `file` store, pointed at a persistent volume path of the n8n container.
- In this mode the recommended setup leaves this tool's channels empty (`channels: {}`) and lets n8n own all notifications.

## 6. Non-Functional Requirements

| Area | Requirement |
| --- | --- |
| Security | Minimal scopes (`gmail.readonly`, read-only Play Console permission). Secrets masked in logs. Email bodies and raw responses never stored in state or notifications. Dependency vulnerability scanning in CI. |
| Reliability | All notifications idempotent. One source failing never blocks other sources or notifications (partial failure tolerated). Network errors retried. |
| Performance | One run completes within 30 seconds for 5 apps and 3 sources. Gmail queries use server-side `q` filtering. |
| Observability | Structured logs, run summary (event count, delivery results), Action Job Summary. `--verbose` prints per-source response digests. |
| Compatibility | Node 20/22; ubuntu, macos, windows runners; GitHub Enterprise Server. |
| Testing | Unit coverage of 90%+ (rule parsing, state diff, templates). Email fixture regression tests. Play API, Gmail, and webhooks mocked. E2E via a dry-run workflow. |
| Documentation | README (5-minute quick start), Gmail OAuth guide, service account guide, configuration reference, adapter authoring guide. Korean and English. |
| License | Keep the repository LICENSE (Apache-2.0). |

## 7. Architecture Overview

```
┌────────────┐  ┌─────────────┐  ┌───────────────┐
│ Email      │  │ Play API    │  │ Store Listing │   SourceAdapter[]
│ (Gmail)    │  │ (androidpub)│  │ (HTML)        │
└─────┬──────┘  └──────┬──────┘  └──────┬────────┘
      └────────────────┼────────────────┘
                       ▼
             ┌───────────────────┐
             │ Normalizer        │  → ReviewEvent[]
             └─────────┬─────────┘
                       ▼
             ┌───────────────────┐      ┌────────────┐
             │ Dedupe / Diff     │◄────►│ StateStore │ (github-cache | file | custom)
             └─────────┬─────────┘      └────────────┘
                       ▼
             ┌───────────────────┐
             │ Router + Template │  (per-app / per-event channels, rendering)
             └─────────┬─────────┘
                       ▼
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  ┌───────────┐  ┌───────────┐  ┌───────────────┐
  │ Slack     │  │ Discord   │  │ HTTP Webhook  │   Notifier[]
  └───────────┘  └───────────┘  └───────┬───────┘
                                        ▼
                                  n8n / Make / custom server

  Entry points: CLI (`run`) / GitHub Action (`dist/index.js`) → both call the same `runOnce(config)`
```

Package layout (tentative, single npm package):

```
src/
  core/        # runOnce, event model, dedupe, router
  sources/     # email/, play-api/, store-listing/, manual/
  notifiers/   # slack/, discord/, webhook/
  state/       # github-cache, file, none
  templates/   # default templates
  rules/email/ # email classification rule sets (JSON per locale)
  schemas/     # JSON Schemas for configuration and webhook payload
examples/n8n/  # importable n8n workflow JSON
  cli/         # commander-based commands
  action/      # @actions/core wrapper
action.yml
dist/index.js  # ncc bundle (committed)
```

## 8. Detailed Design Notes

### 8.1 Email rule set format

```json
{
  "locale": "en",
  "rules": [
    {
      "type": "REJECTED",
      "subject": ["has been rejected", "Update rejected", "wasn't published"],
      "body": [],
      "extract": {
        "appName": "regex:Your app (.+?) \\(",
        "packageName": "regex:\\(([a-z][a-z0-9_]*(\\.[a-z0-9_]+)+)\\)",
        "reason": "section:Issue|Reason|Policy"
      }
    }
  ]
}
```

- Rules are evaluated top to bottom; the first match wins. No match plus a passing sender allowlist yields `UNKNOWN_NOTICE`.
- Phase 0 collects real samples (approval, rejection, policy warning, removal, suspension), stores them as fixtures, and finalizes the rules. The pattern strings in this document are unvalidated drafts.

### 8.2 Play API inference decision table (hypothesis, finalized in Phase 0)

| Previous state | Current observation | Event | Confidence |
| --- | --- | --- | --- |
| versionCode V absent | V on track (completed/inProgress) | `SUBMITTED` | medium |
| V observed, LIVE unconfirmed | Email APPROVED or store listing changed | `LIVE` | high |
| V observed | V gone, no higher version | rejection candidate (record only) | low |
| V observed | V gone, higher version W appears | `SUBMITTED` (W) | medium |
| status halted | — | record only | — |

To validate: how `edits.tracks.get` exposes a release while under review, whether a rejected release disappears from the track, and how managed publishing changes the picture.

### 8.3 State schema

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-09-07T09:00:00Z",
  "email": {
    "watermark": "2026-09-07T08:50:00Z",
    "processedMessageIds": ["18f3..."]
  },
  "apps": {
    "com.example.app": {
      "tracks": {
        "production": { "versionCodes": ["1203"], "status": "completed", "observedAt": "..." }
      },
      "storeListing": { "versionName": "3.4.1", "updatedOn": "Sep 5, 2026" },
      "lastLiveVersionCode": "1203"
    }
  },
  "events": {
    "email:18f3...": { "type": "REJECTED", "at": "...", "delivered": true, "attempts": 1 }
  }
}
```

- `events` is capped at the most recent 500 entries or 30 days to bound size.

### 8.4 Default message format (Slack example)

```
🚫 REJECTED — Example App (com.example.app)
Track: production · Version: 3.4.2 (1204)
Reason: The app's ... (truncated)
Open in Play Console →
Source: email · 2026-09-07 09:00 UTC
```

Colors per event: SUBMITTED gray, APPROVED/LIVE green, REJECTED red, POLICY_WARNING orange, REMOVED/SUSPENDED dark red.

## 9. Distribution and Releases

- npm: `@jaesunglee/google-play-review-notify`. `npx @jaesunglee/google-play-review-notify run`.
- GitHub Marketplace: `JaesungLeee/google-play-review-notify`. The `v1` major tag is moved to the latest v1.x.
- Release automation: Conventional Commits → changesets or release-please for CHANGELOG, tags, npm publish, and `dist/` bundle refresh.
- Email rule set changes ship quickly as patch versions.

## 10. Roadmap

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **0. Technical spike** | Collect real email samples, observe Play API track responses (at least one each of under review / rejected / approved), confirm store listing parseability | Rule set fixtures for 8.1, decision table for 8.2 finalized |
| **1. MVP** | Core pipeline, email adapter, Slack/Discord webhooks, file and github-cache state stores, CLI `run / auth gmail / test-notify`, GitHub Action, README | Approval and rejection notifications received for one real app |
| **2. Secondary signals and ergonomics** | Play API adapter (SUBMITTED/LIVE), per-app routing, template overrides, generic webhook channel (HMAC signature, payload schema), example n8n workflows, `doctor`, `init`, Job Summary, reusable workflow | Scenario with 2+ apps and 2+ channels passes; events received by an n8n Webhook Trigger |
| **3. Extensions** | Store listing adapter, `emit`, Korean rule set, custom StateStore/Notifier loading, Marketplace listing, n8n Execute Command guide | One external repository adopts it |
| **4. Ecosystem** | n8n community node (`n8n-nodes-google-play-review-notify`, reusing the core library) | Community node published |

## 11. Success Metrics

- Latency from approval/rejection email arrival to notification: within schedule interval + 1 minute (P95)
- Misclassification rate: 0% on fixtures, at most 1 per month in production
- Duplicate notifications: 0
- Time to adopt in a new project: under 15 minutes following the docs
- External adoptions, GitHub stars, issue response time (open-source metrics)

## 12. Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Google changes email subject/body formats | Classification fails → missed notifications | Optional `UNKNOWN_NOTICE` fallback, rule set patch releases, fixture regression tests |
| Play Console sometimes sends no email on rejection (reported in community threads) | Missed detection | API adapter records rejection candidates, `doctor` guidance, limitation documented |
| Gmail refresh token expiry (7 days for OAuth apps in testing mode) | Auth failure | Docs instruct publishing the OAuth app to production; one-time warning notification on failure |
| Actions Cache 7-day eviction | State loss → re-baseline | Schedules under 7 days are unaffected; silent re-baseline on loss (D11); custom stores possible |
| Store listing HTML changes | Parsing failure | Off by default, failure tolerated, warning after consecutive failures |
| Dependence on a personal Gmail account | Breaks when the owner leaves | Docs recommend a shared developer account or group mailbox |
| Over-privileged service account | Security | Only read-only permission required; `doctor` warns on excess |

## 13. Open Issues

1. Play Console usually sends no "entered review" email, so `SUBMITTED` depends on the API adapter or `emit`. Phase 0 must confirm API observation is sufficient.
2. Measure how often emails lack a package name before finalizing the app-name matching strategy.
3. ~~Finalize the npm package name and GitHub organization.~~ → Resolved: npm `@jaesunglee/google-play-review-notify`, GitHub `JaesungLeee/google-play-review-notify` (2026-09-07)
4. Decide the UX for distinguishing "approved (pending publish)" from "live" for apps using managed publishing.
5. Google Workspace domain-wide delegation: currently a non-goal; revisit as P2 on request.
6. If an n8n community node is built, decide between a trigger node (polling) and an action node (single run). An action node that calls the core library's `runOnce(config)` directly is the simpler implementation.

## 14. Appendix: Glossary

- **Track**: production, beta (open testing), alpha (closed testing), internal, custom tracks
- **versionCode / versionName**: the integer build version and the display version of an Android build
- **Managed publishing**: a Play Console option where the developer chooses when to publish after approval
- **Incoming Webhook**: the URL-based message endpoint provided by Slack and Discord
- **n8n**: a node-based workflow automation tool. Its Webhook Trigger node starts a workflow from an external HTTP request, and on self-hosted instances the Execute Command node can run shell commands.
