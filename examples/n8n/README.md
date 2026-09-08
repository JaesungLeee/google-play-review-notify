# n8n examples

Planned importable workflows (see docs/PRD_ko.md §5.9.2, Phase 2):

- `webhook-to-slack-discord.json` — Webhook Trigger → HMAC verification → Switch(event type) → Slack/Discord
- `rejected-to-jira.json` — create a Jira issue for `REJECTED` events
- `schedule-execute-cli.json` — Schedule Trigger → Execute Command (`npx play-review-notify run --json`)

Signature verification (Code node):

```js
const crypto = require('crypto');
const secret = $env.PLAY_REVIEW_WEBHOOK_SECRET;
const ts = $input.first().headers['x-play-review-timestamp'];
const sig = $input.first().headers['x-play-review-signature'];
const body = JSON.stringify($input.first().body);
const expected =
  'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
if (sig !== expected) throw new Error('invalid signature');
return $input.all();
```
