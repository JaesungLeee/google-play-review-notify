# n8n examples

Two importable workflows (n8n → **Workflows → Import from File**). They were written against
n8n 1.x node versions and are meant as starting points: swap the final HTTP Request nodes for the
Slack, Discord, Jira, or Notion nodes you already use.

| File                                                 | Trigger          | What it does                                                                                                  |
| ---------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| [webhook-to-slack.json](./webhook-to-slack.json)     | Webhook          | Verifies `X-Play-Review-Signature`, splits batches into items, routes `REJECTED` and other events to Slack     |
| [schedule-run-cli.json](./schedule-run-cli.json)     | Schedule Trigger | Runs `play-review-notify run --json` every 10 minutes on the n8n host and emits one item per new event         |

## Webhook → Slack

1. Import the workflow and activate it. Copy the production webhook URL from the Webhook node.
2. In n8n's environment set `PLAY_REVIEW_WEBHOOK_SECRET` (any long random string) and
   `SLACK_WEBHOOK_URL`, and allow Code nodes to read them: `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`.
   For a quick test you can instead paste the values into the Code and HTTP Request nodes.
3. Point a channel at it:

   ```yaml
   channels:
     n8n:
       type: webhook
       url: ${N8N_WEBHOOK_URL} # the production URL from step 1
       secret: ${N8N_WEBHOOK_SECRET} # same value as PLAY_REVIEW_WEBHOOK_SECRET
       batch: true # optional: one request per run with an array body
   defaultChannels: [n8n]
   ```

4. `play-review-notify test-notify` sends a sample `REJECTED` through the whole chain.

The request body follows [schemas/webhook-payload.schema.json](../../schemas/webhook-payload.schema.json):
one payload object, or an array of them when `batch: true`. The signature is
`sha256=HMAC-SHA256(secret, "<X-Play-Review-Timestamp>.<raw body>")`. The body is compact JSON, so
`JSON.stringify` of the parsed body in the Code node reproduces the signed bytes.

## Scheduled CLI run

Use this when n8n runs on a machine that can also run the CLI (for example the same Docker host)
and you want n8n, not GitHub Actions, to own the schedule. Requires Node.js 20+ inside the n8n
container and a config file plus environment variables in `/data/play-review-notify` (adjust the
path in the Execute Command node). Every new event becomes one item that you can route to any node;
the CLI still sends to the channels in its own config, so leave `channels` empty there if n8n should
be the only notifier.

## Signature verification without the example

```js
const crypto = require('crypto');
const secret = $env.PLAY_REVIEW_WEBHOOK_SECRET;
const req = $input.first().json;
const ts = req.headers['x-play-review-timestamp'];
const sig = req.headers['x-play-review-signature'];
const expected =
  'sha256=' +
  crypto.createHmac('sha256', secret).update(`${ts}.${JSON.stringify(req.body)}`).digest('hex');
if (sig !== expected) throw new Error('invalid signature');
const payloads = Array.isArray(req.body) ? req.body : [req.body];
return payloads.map((p) => ({ json: p }));
```
