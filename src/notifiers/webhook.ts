/**
 * Generic HTTP webhook (n8n, Make, custom servers). See docs/design.md, "Notifiers", for the
 * payload contract and headers.
 */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { fetchWithRetry, type RetryOptions } from '../core/http';
import {
  REVIEW_EVENT_TYPES,
  type ChannelTarget,
  type Notifier,
  type RenderedMessage,
} from '../core/types';

export const WEBHOOK_PAYLOAD_VERSION = 1 as const;

/** `ReviewEvent` without `raw`, as it appears on the wire. */
export const webhookEventSchema = z
  .object({
    id: z
      .string()
      .describe(
        'Stable dedupe key, e.g. "email:<gmailMessageId>" or "api:<pkg>:<track>:<versionCode>:SUBMITTED". Retries reuse it.',
      ),
    type: z.enum(REVIEW_EVENT_TYPES).describe('Event type after mergeInto is applied.'),
    packageName: z
      .string()
      .nullable()
      .describe('Android application id; null when the source could not identify the app.'),
    appName: z.string().optional().describe('Display name from the email or the config.'),
    track: z.string().optional().describe('production, beta, alpha, internal, ...'),
    versionCode: z.string().optional(),
    versionName: z.string().optional(),
    reason: z
      .string()
      .optional()
      .describe('Rejection or warning reason, plain text, capped at reasonMaxLength.'),
    consoleUrl: z.string().optional().describe('Deep link into Play Console when known.'),
    source: z.enum(['email', 'play-api', 'manual']),
    confidence: z.enum(['high', 'medium', 'low']),
    observedAt: z.string().describe('ISO 8601 time the signal was observed.'),
    followUp: z
      .boolean()
      .optional()
      .describe(
        'True when this repeats an already-delivered event because a later source added details (typically the rejection reason).',
      ),
  })
  .describe('A normalized review event.');

export const webhookPayloadSchema = z
  .object({
    payloadVersion: z.literal(WEBHOOK_PAYLOAD_VERSION).describe('Payload format version.'),
    sentAt: z.string().describe('ISO 8601 time the request was built.'),
    event: webhookEventSchema,
    app: z
      .object({
        packageName: z.string().nullable(),
        name: z.string().optional().describe('From the config, or the event when not configured.'),
        tracks: z.array(z.string()).optional().describe('Configured tracks for the app.'),
      })
      .describe('The configured app the event belongs to.'),
    run: z.object({
      id: z.string().describe('Run identifier, e.g. "gha:<runId>" or "local:<pid>".'),
      dryRun: z.boolean(),
    }),
  })
  .describe('One event delivered to a webhook channel.');

/** Request body: one payload, or an array of payloads when the channel has `batch: true`. */
export const webhookBodySchema = z
  .union([webhookPayloadSchema, z.array(webhookPayloadSchema).min(1)])
  .describe(
    'Body of a play-review-notify webhook request: one payload, or an array when the channel has batch: true.',
  );

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

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
    const app: WebhookPayload['app'] = { packageName: event.packageName };
    const name = m.app?.name ?? event.appName;
    if (name) app.name = name;
    if (m.app) app.tracks = m.app.tracks;
    return {
      payloadVersion: WEBHOOK_PAYLOAD_VERSION,
      sentAt: this.now().toISOString(),
      event,
      app,
      run: { id: this.opts.runId ?? `local:${process.pid}`, dryRun: false },
    };
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
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
    await this.post(channel, JSON.stringify(this.buildPayload(message)), message.event.type);
  }

  /** `batch: true`: one request whose body is an array of payloads; `X-Play-Review-Event: batch`. */
  async sendBatch(messages: RenderedMessage[], channel: ChannelTarget): Promise<void> {
    if (messages.length === 0) return;
    const body = JSON.stringify(messages.map((m) => this.buildPayload(m)));
    await this.post(channel, body, 'batch');
  }

  private async post(channel: ChannelTarget, body: string, eventHeader: string): Promise<void> {
    const url = channel['url'];
    if (typeof url !== 'string') throw new Error(`Webhook channel ${channel.name} has no url`);
    const timestamp = String(Math.floor(this.now().getTime() / 1000));
    const headers = this.buildHeaders(channel, body, timestamp);
    headers['x-play-review-event'] = eventHeader;
    await fetchWithRetry(url, { method: 'POST', headers, body }, this.opts.retry ?? {});
  }
}
