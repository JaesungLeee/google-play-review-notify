import { fetchWithRetry, type RetryOptions } from '../core/http';
import type { ChannelTarget, Notifier, RenderedMessage } from '../core/types';

/** Discord Webhook (embed). See FR-NOTIFY-2. */
export class DiscordNotifier implements Notifier {
  readonly type = 'discord';
  constructor(private readonly retry: RetryOptions = {}) {}

  buildPayload(m: RenderedMessage): Record<string, unknown> {
    return {
      content: m.mentions.length ? m.mentions.join(' ') : undefined,
      embeds: [
        {
          title: m.title,
          description: m.body.slice(0, 4000),
          color: parseInt(m.color, 16),
          fields: m.fields.map((f) => ({ name: f.label, value: f.value, inline: true })),
          timestamp: m.event.observedAt,
        },
      ],
    };
  }

  async send(message: RenderedMessage, channel: ChannelTarget): Promise<void> {
    const url = channel['webhookUrl'];
    if (typeof url !== 'string')
      throw new Error(`Discord channel ${channel.name} has no webhookUrl`);
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
