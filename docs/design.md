# Design

How google-play-review-notify turns the few signals Google Play exposes into reliable
notifications. Read this before adding a source, notifier, or rule set.

## Goals and non-goals

Goals: detect review-related events (submitted, approved, rejected, live, policy notices) for
any app in any Play Console account without human polling; deliver them to Slack, Discord, or any HTTP
receiver; run anywhere a scheduler exists (GitHub Actions, cron, n8n) with no server of its own;
keep sources, state stores, and notifiers pluggable.

Out of scope:

- Scraping or automating the Play Console web UI (terms-of-service risk, brittle).
- Uploading builds or creating releases (Fastlane, gradle-play-publisher and friends do that).
- App Store Connect. The adapter design allows it later.
- User reviews and ratings. Different domain.
- A long-running daemon. Scheduling is delegated to the caller.

## Event model

Every source normalizes its findings into a `ReviewEvent` (`src/core/types.ts`):

| Field         | Meaning                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| `id`          | Stable dedupe key: `email:<gmailMessageId>`, `api:<pkg>:<track>:<versionCode>:<TYPE>`  |
| `type`        | `PENDING_SUBMISSION`, `SUBMITTED`, `APPROVED`, `REJECTED`, `LIVE`, `POLICY_WARNING`      |
| `packageName` | `null` when the source could not identify the app (an email without the package name)  |
| `appName`, `track`, `versionCode`, `versionName`, `reason`, `consoleUrl` | Optional details; `reason` is length-capped |
| `source`      | `email`, `play-api`, `manual`                                                            |
| `confidence`  | `high` for both adapters; kept for `emit` callers and future inference sources           |
| `observedAt`  | ISO 8601                                                                                 |
| `followUp`    | `true` when the event repeats an already-delivered one to add details (the rejection reason) |

Rules that every source follows:

- An event id is deterministic, so the same fact reported twice (or by two sources using the
  same id scheme, such as `emit` and the Play API adapter) is delivered once.
- A source never throws for one app's failure; it logs, keeps that app's last good state, and
  continues. It throws only when nothing could be polled, which the run summary reports as a
  failed source (exit code 2).
- On a baseline run (`ctx.baseline`, no prior state) and on the first sight of a package, a
  source records state and emits nothing.

## What each signal can and cannot say

| Signal                                                     | Tells you                                                                                  | Does not tell you                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Play Developer API (`applications.tracks.releases.list`)   | Each release's `releaseLifecycleState`: not sent, in review, approved (not published), not approved, published | The reason for a rejection; account-level notices |
| Play Console email                                         | Policy warnings with a deadline; the reason text of a rejection                            | Approval of an update: Google normally sends no email for it |

The release lifecycle endpoint appeared in the API between February and May 2026 (it is absent
from `@googleapis/androidpublisher` 35.3.0 and present in 35.4.0). The older `edits.tracks.list`
reports a release under review as `status: completed`, which is why earlier versions of this tool
had to infer `LIVE` from the public store page; that adapter is gone.

Consequences baked into the adapters:

- Policy emails share one subject line for rejections and deadline warnings. Classification uses
  the body: `App Status: Rejected` / `앱 상태: 거부됨` means rejected, `Status: Further action
  required` / `상태: 추가 조치 필요` means warning.
- Rejection emails come from `no-reply-googleplay-developer@google.com`; newsletters and terms
  updates come from `googleplay-noreply@google.com`. Both are allowlisted; emails that match no
  rule are logged at debug level and dropped.
- A rejection is reported twice: by the API (no reason) and by the email (with reason). The
  pipeline recognises the repeat by `packageName:versionCode:REJECTED` and sends the email as a
  follow-up (`followUp: true`, title suffixed "(reason added)") when the first notification had
  no reason; see "Pipeline".

### Play API transition table

State per release, keyed by its artifacts (`releaseKey`: sorted version codes), per track. The
event is decided by the state entered, not by the path taken:

| Previous state                              | Current state            | Events                       |
| ------------------------------------------- | ------------------------ | ---------------------------- |
| Package or track seen for the first time; baseline run | anything      | record only                  |
| anything else                               | `DRAFT`                  | none                         |
| not `NOT_SENT_FOR_REVIEW`                   | `NOT_SENT_FOR_REVIEW`    | `PENDING_SUBMISSION`         |
| not `IN_REVIEW`                             | `IN_REVIEW`              | `SUBMITTED`                  |
| not `APPROVED_NOT_PUBLISHED`                | `APPROVED_NOT_PUBLISHED` | `APPROVED`                   |
| not `NOT_APPROVED`                          | `NOT_APPROVED`           | `REJECTED`                   |
| unseen release, or `APPROVED_NOT_PUBLISHED` | `PUBLISHED`              | `LIVE`                       |
| any other state                             | `PUBLISHED`              | `APPROVED` then `LIVE`       |
| any                                         | no longer listed         | dropped from state, no event |

Version code in the id is the highest artifact of the release; `versionName` is the release name.
State written by 0.4 and earlier (`versions` per track) is treated as unseen, so an upgrade baselines silently.

Confirmed on a real account (2026-09-11): "View app information (read-only)" is enough for the
endpoint, and a release under review is reported as `IN_REVIEW` while `edits.tracks.list` shows
the same release as `status: completed`. Still being confirmed: whether a rejected release stays
listed as `NOT_APPROVED` or disappears, and whether a halted staged rollout is distinguishable
from `PUBLISHED` (the docs say it is not).

### Email rule sets

`rules/email/<locale>.json`, evaluated top to bottom across all bundled sets (English first); the
first subject or body match wins, and an allowlisted sender with no match is ignored (logged at
debug level). Extractors are `regex:<pattern>` (first capture group) or
`section:<Heading|Alt>` (text after a heading line until a blank line). Rule sets are data, so
new email wording ships as a patch release without code changes. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for adding a locale.

## Pipeline

```
┌────────────┐  ┌─────────────┐  ┌───────────────┐
│ Play API   │  │ Email       │  │ Manual        │   SourceAdapter[]
│ (releases) │  │ (Gmail)     │  │ (emit)        │
└─────┬──────┘  └──────┬──────┘  └──────┬────────┘
      └────────────────┼────────────────┘
                       ▼
             ┌───────────────────┐
             │ Normalize         │  → ReviewEvent[]
             └─────────┬─────────┘
                       ▼
             ┌───────────────────┐      ┌────────────┐
             │ Dedupe / merge    │◄────►│ StateStore │  file | github-cache | none | custom
             └─────────┬─────────┘      └────────────┘
                       ▼
             ┌───────────────────┐
             │ Route + render    │  per-app / per-event channels, language, templates
             └─────────┬─────────┘
                       ▼
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  ┌───────────┐  ┌───────────┐  ┌───────────────┐
  │ Slack     │  │ Discord   │  │ HTTP webhook  │   Notifier[]
  └───────────┘  └───────────┘  └───────────────┘
```

Both entry points (CLI `run`, GitHub Action) call the same `runOnce()` in `src/core/run.ts`:

1. Poll every enabled source; one failure never blocks the others.
2. Drop events already in state; apply `mergeInto` (for example `LIVE` → `APPROVED`); drop
   disabled types. Then match the logical key `packageName:versionCode:type` against the ledger
   and the run: a repeat from another source (or of a merged type) is suppressed, unless it adds
   a reason the delivered event lacked and `reasonFollowUp` is on, in which case it is delivered
   as a follow-up. Two reports in one run collapse into one event carrying both sets of details.
   Repeats from the same source keep their own ids and are delivered.
3. Baseline run: record everything as suppressed and stop.
4. Otherwise record each event as pending, deliver to its channels, record the outcome. Failed
   deliveries are retried on later runs up to `maxRetries`.
5. Persist state (skipped on `--dry-run`).

Delivery order matters: the event id is written to state before the first send attempt, so a
crash between sending and saving cannot produce a duplicate notification on the next run.

## State

One JSON document, `schemaVersion: 1`, per-source opaque sections plus the event ledger:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-09-08T06:49:24.527Z",
  "sources": {
    "email": { "watermark": "2026-08-29T06:49:24.527Z", "processedMessageIds": ["18f3..."] },
    "play-api": { "packages": { "com.example.app": { "tracks": { "production": { "releases": { "4": { "state": "IN_REVIEW", "versionCodes": ["4"], "name": "1.1.0" } } } }, "failures": 0 } } }
  },
  "events": {
    "api:com.example.app:production:4:REJECTED": { "type": "REJECTED", "packageName": "com.example.app", "versionCode": "4", "at": "...", "delivered": true, "attempts": 1, "hasReason": true },
    "email:18f3...": { "type": "REJECTED", "packageName": "com.example.app", "versionCode": "4", "at": "...", "delivered": true, "attempts": 1, "hasReason": true }
  }
}
```

The event ledger is pruned to bound its size. Stores: `file` (CLI default), `github-cache`
(Action default; immutable cache entries are written under `<prefix>-<runId>-<attempt>` and the
newest is restored with a prefix match; entries expire after 7 days without access), `none`, and
`custom` (a local module exporting a `StateStore`).

## Notifiers

- **Slack**: Incoming Webhook, Block Kit. **Discord**: webhook embed. Both use per-event colors
  (rejected red, warning orange, approved/live green, pending/submitted grey) and optional
  mentions.
- **Webhook**: JSON payload for n8n, Make, Zapier, or your own server.

```json
{
  "payloadVersion": 1,
  "sentAt": "2026-09-07T09:00:03Z",
  "event": { "id": "email:18f3...", "type": "REJECTED", "packageName": "com.example.app", "...": "..." },
  "app": { "packageName": "com.example.app", "name": "Example App", "tracks": ["production"] },
  "run": { "id": "gha:1234567890", "dryRun": false }
}
```

| Header                    | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| `Content-Type`            | `application/json`                                               |
| `User-Agent`              | `google-play-review-notify/<version>`                            |
| `X-Play-Review-Event`     | event type                                                       |
| `X-Play-Review-Timestamp` | Unix epoch seconds                                               |
| `X-Play-Review-Signature` | `sha256=HMAC-SHA256(secret, timestamp + "." + body)` when a secret is set |

The body is described by [schemas/webhook-payload.schema.json](../schemas/webhook-payload.schema.json),
generated from the zod schema in `src/notifiers/webhook.ts`. `raw` is never included. Non-2xx
responses are retried with exponential backoff (429 `Retry-After` honored); retries keep the same
`event.id`, so receivers can deduplicate on it.

`batch: true` sends one request per run whose body is a JSON **array** of the payload objects
above (never empty), with `X-Play-Review-Event: batch`; the signature covers the whole array. The
batch succeeds or fails as a unit: on failure every event in it stays pending for that channel and
is retried together on the next run. Channels whose notifier cannot batch fall back to one request
per event. Importable n8n workflows are in [examples/n8n](../examples/n8n/README.md).

## Configuration precedence and CLI contract

- Action: inputs > environment > config file. The config file is optional when the main inputs
  are given.
- Secrets are referenced as `${ENV_VAR}` and never stored in the file; every referenced value is
  redacted from logs.
- CLI exit codes: `0` ok, `1` configuration or authentication error, `2` at least one source
  failed (notifications still sent), `3` at least one notification failed. `doctor` exits `1`
  when any check fails and `0` otherwise, and never sends anything. `--json` prints
  `{ "events": ReviewEvent[], "summary": {...} }`.
- CLI language (`src/cli/i18n.ts`): `--lang` > `$PLAY_REVIEW_NOTIFY_LANG` > the language saved in
  the user's preferences file (`src/cli/prefs.ts`: `$XDG_CONFIG_HOME` or `~/.config`, `%APPDATA%`
  on Windows, `play-review-notify/preferences.json`) > a one-question gate when stdin and stdout
  are TTYs (default from the system locale) > English. The gate's answer is saved, so each user
  is asked once; `lang [en|ko] [--reset]` shows, saves, or forgets it. The gate is skipped for
  `--json`, `--version`, and the `lang` command, so scripts never block on it. A missing or
  malformed preferences file is treated as empty. Only CLI text is translated: help, prompts,
  `doctor` messages and hints, and command output. Check ids, generated files, JSON output, and
  core log lines stay English. An unknown language exits `1`.

## Extending

The plugin interfaces are `SourceAdapter`, `Notifier`, and `StateStore` in `src/core/types.ts`.
Register implementations in `src/sources/index.ts`, `src/notifiers/index.ts`, or
`src/state/index.ts`, extend the zod schema in `src/core/config.ts`, and test with injected fakes
(no network in tests). Custom state stores can also be loaded from a local module without
touching this repository (`stateStore.type: custom`).
