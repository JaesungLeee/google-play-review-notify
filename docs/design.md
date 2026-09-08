# Design

How google-play-review-notify turns the few signals Google Play exposes into reliable
notifications. Read this before adding a source, notifier, or rule set.

## Goals and non-goals

Goals: detect review-related events (submitted, rejected, live, policy notices) for any app in
any Play Console account without human polling; deliver them to Slack, Discord, or any HTTP
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
| `id`          | Stable dedupe key: `email:<gmailMessageId>`, `api:<pkg>:<track>:<versionCode>:<TYPE>`, `store:<pkg>:<epoch>:LIVE` |
| `type`        | `SUBMITTED`, `APPROVED`, `REJECTED`, `LIVE`, `POLICY_WARNING`, `REMOVED`, `SUSPENDED`, `UNKNOWN_NOTICE` |
| `packageName` | `null` when the source could not identify the app (an email without the package name)  |
| `appName`, `track`, `versionCode`, `versionName`, `reason`, `consoleUrl` | Optional details; `reason` is length-capped |
| `source`      | `email`, `play-api`, `store-listing`, `manual`                                           |
| `confidence`  | `high` (email), `medium` (API diff, store listing), `low` (opt-in inference)             |
| `observedAt`  | ISO 8601                                                                                 |

Rules that every source follows:

- An event id is deterministic, so the same fact reported twice (or by two sources using the
  same id scheme, such as `emit` and the Play API adapter) is delivered once.
- A source never throws for one app's failure; it logs, keeps that app's last good state, and
  continues. It throws only when nothing could be polled, which the run summary reports as a
  failed source (exit code 2).
- On a baseline run (`ctx.baseline`, no prior state) and on the first sight of a package, a
  source records state and emits nothing.

## What each signal can and cannot say

Validated against real Play Console emails and Play Developer API responses (September 2026).

| Signal                       | Tells you                                                                 | Does not tell you                                                    |
| ---------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Play Console email           | Rejection with reason; policy warnings with a deadline; removal, suspension | Approval of an update: Google normally sends no email for it        |
| Play Developer API (`edits.tracks.list`) | A new versionCode was submitted to a track                    | Review state: a release under review is already `status: completed`  |
| Public store listing         | A production release actually reached users (404→200, or "Updated on" changed) | Anything about non-production tracks; anything before you press Publish under managed publishing |

Consequences baked into the adapters:

- Policy emails share one subject line for rejections and deadline warnings. Classification uses
  the body: `App Status: Rejected` / `앱 상태: 거부됨` means rejected, `Status: Further action
  required` / `상태: 추가 조치 필요` means warning.
- Rejection emails come from `no-reply-googleplay-developer@google.com`; newsletters and terms
  updates come from `googleplay-noreply@google.com`. Both are allowlisted; the latter mostly
  classify as `UNKNOWN_NOTICE`, which is off by default.
- `LIVE` is emitted by the store listing adapter, not by the API. `emitLiveWithoutConfirmation`
  turns on a low-confidence `LIVE` from the API for apps that have no public listing.

### Play API decision table

| Previous state                     | Current observation                          | Result                                             |
| ---------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| Package or track seen for the first time | anything                               | record only                                        |
| versionCode V absent               | V appears on a configured track              | `SUBMITTED` (medium), release name as `versionName` |
| V present                          | V disappears, no higher version              | log as rejection candidate; the email confirms     |
| V present                          | V disappears, higher W appears               | `SUBMITTED`(W)                                     |
| any                                | `completed` / `inProgress`                   | `LIVE` (low) only with `emitLiveWithoutConfirmation` |

Still unverified: whether a rejected release is removed from the track, and whether managed
publishing's "approved, pending publish" state is visible in the API.

### Email rule sets

`rules/email/<locale>.json`, evaluated top to bottom across all bundled sets (English first); the
first subject or body match wins, and an allowlisted sender with no match becomes
`UNKNOWN_NOTICE`. Extractors are `regex:<pattern>` (first capture group) or
`section:<Heading|Alt>` (text after a heading line until a blank line). Rule sets are data, so
new email wording ships as a patch release without code changes. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for adding a locale.

## Pipeline

```
┌────────────┐  ┌─────────────┐  ┌───────────────┐
│ Email      │  │ Play API    │  │ Store listing │   SourceAdapter[]
│ (Gmail)    │  │ (tracks)    │  │ (public page) │
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
             │ Route + render    │  per-app / per-event channels, templates
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
   disabled types.
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
    "play-api": { "packages": { "com.example.app": { "tracks": { "production": { "versions": { "3": "1.0.0" } } }, "failures": 0 } } },
    "store-listing": { "packages": { "com.example.app": { "published": false, "failures": 0 } } }
  },
  "events": {
    "email:18f3...": { "type": "REJECTED", "packageName": "com.example.app", "at": "...", "delivered": true, "attempts": 1 }
  }
}
```

The event ledger is pruned to bound its size. Stores: `file` (CLI default), `github-cache`
(Action default; immutable cache entries are written under `<prefix>-<runId>-<attempt>` and the
newest is restored with a prefix match; entries expire after 7 days without access), `none`, and
`custom` (a local module exporting a `StateStore`).

## Notifiers

- **Slack**: Incoming Webhook, Block Kit. **Discord**: webhook embed. Both use per-event colors
  (rejected red, warning orange, live green, removed/suspended dark red) and optional mentions.
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

`raw` is never included. Non-2xx responses are retried with exponential backoff (429
`Retry-After` honored); retries keep the same `event.id`, so receivers can deduplicate on it.
`batch: true` sends one array per run instead of one request per event.

## Configuration precedence and CLI contract

- Action: inputs > environment > config file. The config file is optional when the main inputs
  are given.
- Secrets are referenced as `${ENV_VAR}` and never stored in the file; every referenced value is
  redacted from logs.
- CLI exit codes: `0` ok, `1` configuration or authentication error, `2` at least one source
  failed (notifications still sent), `3` at least one notification failed. `doctor` exits `1`
  when any check fails and `0` otherwise, and never sends anything. `--json` prints
  `{ "events": ReviewEvent[], "summary": {...} }`.

## Extending

The plugin interfaces are `SourceAdapter`, `Notifier`, and `StateStore` in `src/core/types.ts`.
Register implementations in `src/sources/index.ts`, `src/notifiers/index.ts`, or
`src/state/index.ts`, extend the zod schema in `src/core/config.ts`, and test with injected fakes
(no network in tests). Custom state stores can also be loaded from a local module without
touching this repository (`stateStore.type: custom`).
