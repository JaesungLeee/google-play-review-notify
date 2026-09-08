import { parseConfig, type Config, type ConfigInput } from '../src/core/config';
import type { Notifier, RenderedMessage, ReviewEvent, ChannelTarget } from '../src/core/types';
import { silentLogger } from '../src/core/logger';

export const logger = silentLogger;

export function makeConfig(overrides: Partial<ConfigInput> = {}): Config {
  return parseConfig({
    apps: [{ packageName: 'com.example.app', name: 'Example App' }],
    channels: { slack: { type: 'slack', webhookUrl: 'https://hooks.slack.com/services/x' } },
    defaultChannels: ['slack'],
    stateStore: { type: 'none' },
    ...overrides,
  });
}

export function makeEvent(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
  return {
    id: 'email:msg-1',
    type: 'REJECTED',
    packageName: 'com.example.app',
    appName: 'Example App',
    track: 'production',
    versionCode: '1204',
    versionName: '3.4.2',
    reason: 'Policy violation',
    source: 'email',
    confidence: 'high',
    observedAt: '2026-09-07T09:00:00.000Z',
    ...overrides,
  };
}

export class RecordingNotifier implements Notifier {
  readonly sent: Array<{ message: RenderedMessage; channel: ChannelTarget }> = [];
  constructor(
    readonly type: string,
    private readonly failFor: Set<string> = new Set(),
  ) {}
  async send(message: RenderedMessage, channel: ChannelTarget): Promise<void> {
    if (this.failFor.has(channel.name)) throw new Error(`boom ${channel.name}`);
    this.sent.push({ message, channel });
  }
}
