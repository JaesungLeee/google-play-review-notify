# Security Policy

This tool handles credentials for a Gmail inbox and a Play Console account, so we take reports
seriously.

## Supported versions

Only the latest `0.x` release on npm and the `v1` tag of the GitHub Action receive fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private reporting: **Security → Report a vulnerability** on
https://github.com/JaesungLeee/google-play-review-notify/security/advisories/new.

Include what you found, how to reproduce it, and the version. You will get an acknowledgement
within 7 days and a fix or a mitigation plan within 30 days for confirmed issues. Credit is given
in the release notes unless you prefer otherwise.

## What this tool does with your data

- **Gmail**: read-only scope (`gmail.readonly`). Message bodies are parsed in memory and never
  written to disk, logs, or notifications. The state file stores Gmail message ids and a
  timestamp. Notifications carry only the extracted fields (event type, app, version, a
  length-capped reason).
- **Play Console**: a service account with "View app information (read-only)". The read-only
  edit used to list tracks is discarded; nothing is written to Play.
- **Store listing**: one unauthenticated HTTPS request per app per run with an explicit
  User-Agent.
- **Secrets**: injected through environment variables, never written to the config file, and
  redacted from logs. Webhook payloads can be signed with HMAC-SHA256 so receivers can verify
  them.

## Hardening tips for users

- Keep the OAuth consent screen in production status and the client id private; rotate the
  client secret and refresh token if they were ever pasted somewhere public.
- Use a dedicated team Google account for the Play notifications inbox.
- In GitHub Actions, keep `permissions` to `contents: read` and `actions: write`.
