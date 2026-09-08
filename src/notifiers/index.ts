import type { Notifier } from '../core/types';
import { DiscordNotifier } from './discord';
import { SlackNotifier } from './slack';
import { WebhookNotifier, type WebhookNotifierOptions } from './webhook';

export { DiscordNotifier, SlackNotifier, WebhookNotifier };

export function createDefaultNotifiers(
  webhookOpts: WebhookNotifierOptions = {},
): Map<string, Notifier> {
  const list: Notifier[] = [
    new SlackNotifier(),
    new DiscordNotifier(),
    new WebhookNotifier(webhookOpts),
  ];
  return new Map(list.map((n) => [n.type, n]));
}
