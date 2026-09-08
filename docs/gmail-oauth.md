# Gmail setup (OAuth refresh token)

한국어: [gmail-oauth.ko.md](./gmail-oauth.ko.md)

This tool reads the notification emails Google Play sends to your developer account (rejections,
policy notices) through the Gmail API. The Gmail API cannot be used with a password; it needs a
**refresh token** obtained through an OAuth consent flow. The steps below are done once and
produce three environment variables.

| Variable              | Value                          |
| --------------------- | ------------------------------ |
| `GMAIL_CLIENT_ID`     | OAuth client id                |
| `GMAIL_CLIENT_SECRET` | OAuth client secret            |
| `GMAIL_REFRESH_TOKEN` | printed by `auth gmail`        |

The only scope requested is `https://www.googleapis.com/auth/gmail.readonly`. The tool cannot
send, delete, or label mail.

## 1. Google Cloud project and the Gmail API

1. Open https://console.cloud.google.com and select or create a project. Reusing the project you
   created for the Play API is fine.
2. Enable the **Gmail API**:

   ```
   https://console.cloud.google.com/apis/library/gmail.googleapis.com
   ```

## 2. OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen** (in the newer UI: **Google Auth Platform →
   Audience**).
2. Choose the user type: **External** for a personal Gmail account, **Internal** only if every
   user is in your Google Workspace organization.
3. Fill in the app name (for example `play-review-notify`) and a support email, then save. No
   scopes need to be added here.
4. With **External**, add the Gmail address that receives the Play emails under **Test users**.

> **Important:** while the consent screen is in "Testing", refresh tokens **expire after 7 days**.
> Once the flow works, press **Publish app** to move it to production. Only a non-sensitive scope
> is used, so no Google review is required, and the "unverified app" warning does not matter for
> your own account.

## 3. Create an OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type must be **Desktop app**. `auth gmail` receives the callback on
   `http://127.0.0.1:<random port>`, and only this client type allows arbitrary loopback ports.
   A "Web application" client will fail with `redirect_uri_mismatch`.
3. Name it and create it. Copy the **client ID** and **client secret**. If the secret is masked
   later, use **Reset secret** or create a new client.

## 4. Obtain the refresh token

Run this on a machine where you can sign in to the Gmail account that receives the Play emails:

```bash
export GMAIL_CLIENT_ID="...apps.googleusercontent.com"
export GMAIL_CLIENT_SECRET="..."
npx play-review-notify auth gmail
```

1. A browser opens with the Google sign-in. Pick **the account that receives the Play emails**.
2. If you see "Google hasn't verified this app", click **Advanced → Go to (app name)**. It is the
   app you just created.
3. Allow the read-only Gmail permission. The browser shows "Authorization complete" and the
   terminal prints the token:

```
Authorized as you@gmail.com. Add this to your environment or CI secrets:

GMAIL_REFRESH_TOKEN=1//0g...
```

Options:

- `--no-open`: print the consent URL instead of opening a browser. The redirect goes to
  `127.0.0.1`, so the command must run on the **same machine** as the browser.
- `--port 8089`: pin the callback port instead of picking a free one.
- `--json`: print `{"refreshToken":"...","emailAddress":"..."}`.

## 5. Store the values

- Local or server: put the three values in `.env` or your shell environment. The config file
  only contains references such as `${GMAIL_CLIENT_ID}`.
- GitHub Actions: add `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REFRESH_TOKEN` under
  **Settings → Secrets and variables → Actions** and pass them through `env` in the workflow.

Verify:

```bash
npx play-review-notify run --dry-run --verbose
```

## Troubleshooting

| Symptom                                                     | Cause and fix                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch`                                     | The OAuth client is not a "Desktop app". Create a new one in step 3.                                                                              |
| `403 Error: org_internal` ("only for users in the org")     | The consent screen is set to Internal. Switch to **External** at https://console.cloud.google.com/auth/audience and add your Gmail as a test user. |
| `access_denied` / stuck at "app isn't verified"             | External type but the account is not a test user. See step 2.4.                                                                                   |
| `Google did not return a refresh token`                     | The client was authorized before. Remove the app at https://myaccount.google.com/permissions and run the command again.                            |
| `invalid_grant` after a few days                            | The consent screen is still in Testing; the token expired. Publish the app and obtain a new token.                                                |
| "Blocked by your administrator" on a company account        | A Workspace admin restricts third-party apps. Ask them to allow this client id.                                                                   |

## Recommendations

- Prefer a shared team developer account or a group mailbox over an individual's account so the
  integration survives staff changes.
- Treat the refresh token like a password. Never commit it; if it leaks, revoke it at the
  permissions page above.
