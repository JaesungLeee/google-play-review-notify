# Play Developer API setup (service account)

한국어: [play-api-setup.ko.md](./play-api-setup.ko.md)

The Play API source emits a `SUBMITTED` event the moment a new versionCode appears on a track.
Authentication uses a Google Cloud **service account** JSON key; in Play Console the account only
needs **read-only** access.

> What the Play API can **not** tell you: whether a release is in review, approved, or rejected.
> A release under review is already reported as `status: completed` (verified in Phase 0).
> Rejections come from the email source and going live from the store listing source. See the
> decision table in the [PRD, section 8.2](./PRD_en.md#82-play-api-inference-decision-table-finalized-in-phase-0-2026-09-08).

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
    # emitLiveWithoutConfirmation: true   # only for apps without a public listing (internal-only)
```

In GitHub Actions, store the whole key file content in the `PLAY_SERVICE_ACCOUNT_JSON` secret and
pass it through the `play-service-account-json` input or the `env` block.

Verify:

```bash
npx play-review-notify run --dry-run --verbose
# [DEBUG] Source play-api produced 0 event(s)
```

To see the raw API response, use the spike script from a checkout of this repository:

```bash
PLAY_SERVICE_ACCOUNT_FILE=~/secrets/play-sa.json npm run spike:play -- com.example.app snapshot
```

## Detection rules

| Previous state              | Current observation                   | Action                                                                     |
| --------------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| Package seen for the first time | anything                          | record only                                                                |
| versionCode V absent        | V appears on the track                | `SUBMITTED` (confidence medium), release name used as `versionName`        |
| V present                   | V disappears, no higher version       | log only (rejection candidate); the rejection email produces the event     |
| V present                   | V disappears, higher W appears        | `SUBMITTED`(W)                                                             |
| any                         | `completed` / `inProgress`            | `LIVE` (low) only when `emitLiveWithoutConfirmation: true`                 |

Event ids are `api:<package>:<track>:<versionCode>:SUBMITTED`, the same key used by
`emit --type SUBMITTED`, so a CI pipeline that emits right after upload and this source never
notify twice.

## Troubleshooting

| Symptom                                                    | Cause and fix                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `403 ... insufficient permissions` / `not have permission` | Step 3 has not propagated yet, or the app is missing from the app permissions. Retry after 10 minutes.     |
| `403 ... accessNotConfigured` / `API has not been used`    | Step 1 API is disabled. Enable it from the link in the error message.                                      |
| `404 Package not found`                                    | The developer account you invited the service account to does not own that app.                            |
| `invalid_grant` / `Invalid JWT`                            | The key JSON is corrupted or the system clock is off. Re-download the key or sync the clock.               |
