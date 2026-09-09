import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { DiscordNotifier } from '../../src/notifiers/discord';
import { SlackNotifier } from '../../src/notifiers/slack';
import { signPayload, webhookBodySchema, WebhookNotifier } from '../../src/notifiers/webhook';
import { renderMessage } from '../../src/templates';
import { makeConfig, makeEvent } from '../helpers';

const config = makeConfig({ events: { REJECTED: { enabled: true, mentions: ['<!channel>'] } } });
const message = renderMessage(config, makeEvent({ raw: { secret: 'never' } }), config.apps[0]);

function fetchSpy() {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
}

describe('SlackNotifier', () => {
  it('posts Block Kit payload with mentions and color', async () => {
    const fetchImpl = fetchSpy();
    await new SlackNotifier({ fetchImpl }).send(message, {
      name: 's',
      type: 'slack',
      webhookUrl: 'https://hooks/s',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(url).toBe('https://hooks/s');
    expect(body.text).toMatch(/^<!channel> /);
    expect(body.attachments[0].color).toBe('#d73a49');
    expect(body.attachments[0].blocks[0].type).toBe('header');
  });
});

describe('DiscordNotifier', () => {
  it('posts an embed with integer color', async () => {
    const fetchImpl = fetchSpy();
    await new DiscordNotifier({ fetchImpl }).send(message, {
      name: 'd',
      type: 'discord',
      webhookUrl: 'https://hooks/d',
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.content).toBe('<!channel>');
    expect(body.embeds[0].color).toBe(0xd73a49);
    expect(body.embeds[0].title).toContain('Rejected');
  });
});

describe('WebhookNotifier', () => {
  it('sends versioned payload without raw, signed with HMAC', async () => {
    const fetchImpl = fetchSpy();
    const now = () => new Date('2026-09-07T09:00:03Z');
    const n = new WebhookNotifier({ retry: { fetchImpl }, runId: 'gha:1', version: '1.2.3', now });
    await n.send(message, {
      name: 'n8n',
      type: 'webhook',
      url: 'https://n8n/hook',
      secret: 'shh',
      headers: { 'x-extra': '1' },
    });
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const bodyText = String(init?.body);
    const body = JSON.parse(bodyText);

    expect(body.payloadVersion).toBe(1);
    expect(body.event.raw).toBeUndefined();
    expect(body.event.id).toBe('email:msg-1');
    expect(body.app).toEqual({
      packageName: 'com.example.app',
      name: 'Example App',
      tracks: ['production'],
    });
    expect(webhookBodySchema.safeParse(body).success).toBe(true);
    expect(body.run).toEqual({ id: 'gha:1', dryRun: false });

    expect(headers['user-agent']).toBe('google-play-review-notify/1.2.3');
    expect(headers['x-play-review-event']).toBe('REJECTED');
    expect(headers['x-extra']).toBe('1');
    const ts = headers['x-play-review-timestamp']!;
    expect(ts).toBe(String(Math.floor(now().getTime() / 1000)));
    const expected =
      'sha256=' + createHmac('sha256', 'shh').update(`${ts}.${bodyText}`).digest('hex');
    expect(headers['x-play-review-signature']).toBe(expected);
    expect(signPayload('shh', ts, bodyText)).toBe(expected);
  });

  it('sends one array per run when batching, signed over the whole body', async () => {
    const fetchImpl = fetchSpy();
    const n = new WebhookNotifier({ retry: { fetchImpl }, runId: 'gha:2' });
    const second = renderMessage(config, makeEvent({ id: 'email:msg-2', type: 'LIVE' }));
    await n.sendBatch([message, second], {
      name: 'n8n',
      type: 'webhook',
      url: 'https://n8n/hook',
      secret: 'shh',
      batch: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const bodyText = String(init?.body);
    const body = JSON.parse(bodyText);
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((p: { event: { id: string } }) => p.event.id)).toEqual([
      'email:msg-1',
      'email:msg-2',
    ]);
    // An event without a configured app carries no tracks.
    expect(body[1].app).toEqual({ packageName: 'com.example.app', name: 'Example App' });
    expect(headers['x-play-review-event']).toBe('batch');
    expect(headers['x-play-review-signature']).toBe(
      signPayload('shh', headers['x-play-review-timestamp']!, bodyText),
    );
    expect(webhookBodySchema.safeParse(body).success).toBe(true);
    expect(webhookBodySchema.safeParse([]).success).toBe(false);
  });

  it('omits signature without a secret', async () => {
    const fetchImpl = fetchSpy();
    await new WebhookNotifier({ retry: { fetchImpl } }).send(message, {
      name: 'w',
      type: 'webhook',
      url: 'https://w',
    });
    const headers = fetchImpl.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers['x-play-review-signature']).toBeUndefined();
  });
});
