/**
 * Generic HTTP webhook (n8n, Make, custom servers). See docs/PRD_ko.md §5.9.1 for the payload
 * contract and headers. FR-NOTIFY-7..9, FR-INTEG-1..3.
 */
import { createHmac } from 'node:crypto';
import { fetchWithRetry, type RetryOptions } from '../core/http';
import type { ChannelTarget, Notifier, RenderedMessage, ReviewEvent } from '../core/types';

export const WEBHOOK_PAYLOAD_VERSION = 1 as const;

export interface WebhookPayload {
  payloadVersion: typeof WEBHOOK_PAYLOAD_VERSION;
  sentAt: string;
  event: Omit<ReviewEvent, 'raw'>;
  app: { packageName: string | null; name?: string; tracks?: string[] };
  run: { id: string; dryRun: boolean };
}

export interface WebhookNotifierOptions {
  retry?: RetryOptions;
  runId?: string;
  version?: string;
  now?: () => Date;
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export class WebhookNotifier implements Notifier {
  readonly type = 'webhook';
  constructor(private readonly opts: WebhookNotifierOptions = {}) {}

  buildPayload(m: RenderedMessage): WebhookPayload {
    const { raw: _raw, ...event } = m.event;
    return {
      payloadVersion: WEBHOOK_PAYLOAD_VERSION,
      sentAt: (this.opts.now ?? (() => new Date()))().toISOString(),
      event,
      app: { packageName: event.packageName, ...(event.appName ? { name: event.appName } : {}) },
      run: { id: this.opts.runId ?? `local:${process.pid}`, dryRun: false },
    };
  }

  buildHeaders(channel: ChannelTarget, body: string, timestamp: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': `google-play-review-notify/${this.opts.version ?? '0.0.0'}`,
      'x-play-review-timestamp': timestamp,
      ...((channel['headers'] as Record<string, string> | undefined) ?? {}),
    };
    const secret = channel['secret'];
    if (typeof secret === 'string' && secret.length > 0) {
      headers['x-play-review-signature'] = signPayload(secret, timestamp, body);
    }
    return headers;
  }

  async send(message: RenderedMessage, channel: ChannelTarget): Promise<void> {
    const url = channel['url'];
    if (typeof url !== 'string') throw new Error(`Webhook channel ${channel.name} has no url`);
    const body = JSON.stringify(this.buildPayload(message));
    const timestamp = String(Math.floor((this.opts.now ?? (() => new Date()))().getTime() / 1000));
    const headers = this.buildHeaders(channel, body, timestamp);
    headers['x-play-review-event'] = message.event.type;
    await fetchWithRetry(url, { method: 'POST', headers, body }, this.opts.retry ?? {});
  }
}
