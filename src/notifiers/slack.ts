import { fetchWithRetry, type RetryOptions } from '../core/http';
import type { ChannelTarget, Notifier, RenderedMessage } from '../core/types';

/** Slack Incoming Webhook (Block Kit). */
export class SlackNotifier implements Notifier {
  readonly type = 'slack';
  constructor(private readonly retry: RetryOptions = {}) {}

  buildPayload(m: RenderedMessage): Record<string, unknown> {
    const mention = m.mentions.length ? m.mentions.join(' ') + ' ' : '';
    return {
      text: `${mention}${m.title}`,
      attachments: [
        {
          color: `#${m.color}`,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: m.title, emoji: true } },
            ...(m.fields.length
              ? [
                  {
                    type: 'section',
                    fields: m.fields.map((f) => ({
                      type: 'mrkdwn',
                      text: `*${f.label}*\n${f.value}`,
                    })),
                  },
                ]
              : []),
            { type: 'section', text: { type: 'mrkdwn', text: m.body } },
          ],
        },
      ],
    };
  }

  async send(message: RenderedMessage, channel: ChannelTarget): Promise<void> {
    const url = channel['webhookUrl'];
    if (typeof url !== 'string') throw new Error(`Slack channel ${channel.name} has no webhookUrl`);
    await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.buildPayload(message)),
      },
      this.retry,
    );
  }
}
