# Play Developer API setup (service account)

한국어: [play-api-setup.ko.md](./play-api-setup.ko.md)

The Play API source follows every release on the configured tracks through its review lifecycle
(`applications.tracks.releases.list`) and emits `PENDING_SUBMISSION`, `SUBMITTED`, `APPROVED`,
`REJECTED` and `LIVE`. Authentication uses a Google Cloud **service account** JSON key; in Play
Console the account only needs **read-only** access.

> What the Play API can **not** tell you: the reason for a rejection and account-level policy
> notices. Those come from the email source. See the transition table in
> [design.md](./design.md#play-api-transition-table).

| Variable                    | Value                                  |
| --------------------------- | -------------------------------------- |
| `PLAY_SERVICE_ACCOUNT_JSON` | the **content** of the service account key JSON |

For a local CLI you may instead put the key file path directly in the config
(`serviceAccountJson: /path/to/key.json`).

## 1. Google Cloud project and the API

1. Open https://console.cloud.google.com and select or create a project. The Gmail project can be
   reused.
2. Enable the **Google Play Android Developer API**:

   ```
   https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com
   ```

Linking the Cloud project inside Play Console is no longer required; recent Play Console versions
do not have that page anymore.

## 2. Service account and key

1. https://console.cloud.google.com/iam-admin/serviceaccounts → **+ Create service account**.
2. Enter a name (for example `play-review-notify`) → **Create and continue** → skip the role step
   → **Done**. No Cloud IAM role is needed.
3. Copy the account's **email** (`name@project-id.iam.gserviceaccount.com`).
4. Open the account → **Keys** tab → **Add key → Create new key → JSON**. Keep the downloaded
   file outside your repository.

## 3. Grant app access in Play Console

1. https://play.google.com/console → **Users and permissions → Invite new users**.
2. Enter the service account email from step 2.
3. **App permissions** tab → **Add app** → select the apps to watch → check only
   **"View app information (read-only)"**.
4. **Invite user**. Service accounts do not need to accept the invitation and become active
   immediately, but the API may take several minutes (occasionally longer) to reflect it.

## 4. Configuration

```yaml
sources:
  playApi:
    enabled: true
    serviceAccountJson: ${PLAY_SERVICE_ACCOUNT_JSON}

events:
  # SUBMITTED: { enabled: true }            # off by default
  # PENDING_SUBMISSION: { enabled: true }   # off by default
  # LIVE: { mergeInto: APPROVED }           # one message per release instead of approved + live
```

In GitHub Actions, store the whole key file content in the `PLAY_SERVICE_ACCOUNT_JSON` secret and
pass it through the `play-service-account-json` input or the `env` block.

Verify:

```bash
npx play-review-notify doctor
# ✔ play-api.com.example.app: com.example.app: production=[1.1.0:IN_REVIEW(4)]
npx play-review-notify run --dry-run --verbose
# [DEBUG] Play API com.example.app/production: release 1.1.0 IN_REVIEW → APPROVED_NOT_PUBLISHED
```

To see the raw API response, use the spike script from a checkout of this repository:

```bash
PLAY_SERVICE_ACCOUNT_FILE=~/secrets/play-sa.json npm run spike:play -- com.example.app snapshot
```

## Detection rules

The adapter remembers the `releaseLifecycleState` of every release and emits one event per state
entered:

| State entered            | Event                                                          |
| ------------------------ | -------------------------------------------------------------- |
| `NOT_SENT_FOR_REVIEW`    | `PENDING_SUBMISSION`                                           |
| `IN_REVIEW`              | `SUBMITTED`                                                    |
| `APPROVED_NOT_PUBLISHED` | `APPROVED` (managed publishing: waiting for you to press Publish) |
| `NOT_APPROVED`           | `REJECTED` (the email adds the reason as a follow-up)          |
| `PUBLISHED`              | `LIVE`, preceded by `APPROVED` when the approval was not observed (managed publishing off) |

The first observation of a package or track only records state. A release that disappears from
the list is forgotten without an event. The full table is in
[design.md](./design.md#play-api-transition-table).

Event ids are `api:<package>:<track>:<versionCode>:<TYPE>`, the same key used by
`emit --type SUBMITTED`, so a CI pipeline that emits right after upload and this source never
notify twice.

## Troubleshooting

| Symptom                                                    | Cause and fix                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `403 ... insufficient permissions` / `not have permission` | Step 3 has not propagated yet, or the app is missing from the app permissions. Retry after 10 minutes.     |
| `403 ... accessNotConfigured` / `API has not been used`    | Step 1 API is disabled. Enable it from the link in the error message.                                      |
| `404 Package not found`                                    | The developer account you invited the service account to does not own that app.                            |
| `invalid_grant` / `Invalid JWT`                            | The key JSON is corrupted or the system clock is off. Re-download the key or sync the clock.               |
