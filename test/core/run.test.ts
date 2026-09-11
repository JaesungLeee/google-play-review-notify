import { describe, expect, it } from 'vitest';
import { runOnce } from '../../src/core/run';
import type { ReviewEvent, SourceAdapter } from '../../src/core/types';
import { NoneStateStore } from '../../src/state/none';
import { logger, makeConfig, makeEvent, RecordingNotifier } from '../helpers';

function source(events: ReviewEvent[], name: SourceAdapter['name'] = 'email'): SourceAdapter {
  return { name, poll: async () => ({ events, nextState: { polled: true } }) };
}

async function setup(events: ReviewEvent[], overrides = {}) {
  const config = makeConfig(overrides);
  const slack = new RecordingNotifier('slack');
  const store = new NoneStateStore();
  const notifiers = new Map([[slack.type, slack]]);
  const run = (evs = events, dryRun = false) =>
    runOnce({ config, sources: [source(evs)], notifiers, stateStore: store, logger, dryRun });
  return { config, slack, store, run };
}

describe('runOnce', () => {
  it('baselines on first run without sending, then delivers new events', async () => {
    const { slack, run, store } = await setup([makeEvent()]);
    const first = await run();
    expect(first.baseline).toBe(true);
    expect(slack.sent).toHaveLength(0);
    expect((await store.load())?.events['email:msg-1']?.suppressed).toBe(true);

    const second = await run([makeEvent({ id: 'email:msg-2' })]);
    expect(second.baseline).toBe(false);
    expect(second.events.map((e) => e.id)).toEqual(['email:msg-2']);
    expect(slack.sent).toHaveLength(1);
    expect(second.hasRejection).toBe(true);
  });

  it('never re-sends an event id already in state', async () => {
    const { slack, run } = await setup([makeEvent()]);
    await run(); // baseline
    await run([makeEvent({ id: 'email:msg-2' })]);
    await run([makeEvent({ id: 'email:msg-2' })]);
    expect(slack.sent).toHaveLength(1);
  });

  it('skips disabled event types', async () => {
    const { slack, run } = await setup([], { events: { REJECTED: { enabled: false } } });
    await run();
    const s = await run([makeEvent({ id: 'email:msg-2' })]);
    expect(s.events).toHaveLength(0);
    expect(slack.sent).toHaveLength(0);
  });

  it('merges LIVE into APPROVED and suppresses when APPROVED already recorded', async () => {
    const { slack, run } = await setup([], {
      events: { LIVE: { enabled: true, mergeInto: 'APPROVED' } },
    });
    await run();
    await run([makeEvent({ id: 'email:a', type: 'APPROVED' })]);
    const s = await run([makeEvent({ id: 'api:x', type: 'LIVE', source: 'play-api' })]);
    expect(s.events).toHaveLength(0);
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]?.message.event.type).toBe('APPROVED');
  });

  it('routes per-app channels and records pending channels on failure, then retries', async () => {
    const config = makeConfig({
      apps: [{ packageName: 'com.example.app', channels: ['a', 'b'] }],
      channels: {
        a: { type: 'slack', webhookUrl: 'https://hooks.slack.com/a' },
        b: { type: 'slack', webhookUrl: 'https://hooks.slack.com/b' },
      },
      defaultChannels: [],
    });
    const failing = new RecordingNotifier('slack', new Set(['b']));
    const store = new NoneStateStore();
    const notifiers = new Map([['slack', failing]]);
    const opts = { config, notifiers, stateStore: store, logger };

    await runOnce({ ...opts, sources: [source([])] });
    const s1 = await runOnce({ ...opts, sources: [source([makeEvent()])] });
    expect(s1.deliveries).toEqual([
      { eventId: 'email:msg-1', channel: 'a', ok: true },
      { eventId: 'email:msg-1', channel: 'b', ok: false, error: 'boom b' },
    ]);
    expect((await store.load())?.events['email:msg-1']).toMatchObject({
      delivered: false,
      pendingChannels: ['b'],
      attempts: 1,
    });

    failing['failFor'].clear();
    const s2 = await runOnce({ ...opts, sources: [source([])] });
    expect(s2.deliveries).toEqual([{ eventId: 'email:msg-1', channel: 'b', ok: true }]);
    expect((await store.load())?.events['email:msg-1']).toMatchObject({
      delivered: true,
      attempts: 2,
    });
  });

  it('delivers all events of a run in one request to a batch channel and retries the batch', async () => {
    const config = makeConfig({
      channels: {
        hook: { type: 'webhook', url: 'https://n8n/hook', batch: true },
        single: { type: 'webhook', url: 'https://other/hook' },
      },
      defaultChannels: ['hook', 'single'],
    });
    const batches: number[] = [];
    let fail = true;
    const webhook = {
      type: 'webhook',
      sent: [] as string[],
      send: async (m: { event: { id: string } }) => {
        webhook.sent.push(m.event.id);
      },
      sendBatch: async (ms: Array<{ event: { id: string } }>) => {
        batches.push(ms.length);
        if (fail) throw new Error('n8n down');
      },
    };
    const store = new NoneStateStore();
    const opts = { config, notifiers: new Map([['webhook', webhook]]), stateStore: store, logger };
    await runOnce({ ...opts, sources: [source([])] });

    const events = [makeEvent(), makeEvent({ id: 'email:msg-2', type: 'LIVE' })];
    const s1 = await runOnce({ ...opts, sources: [source(events)] });
    expect(batches).toEqual([2]);
    expect(webhook.sent).toEqual(['email:msg-1', 'email:msg-2']);
    expect(s1.deliveries.filter((d) => d.channel === 'hook').map((d) => d.ok)).toEqual([
      false,
      false,
    ]);
    const state1 = await store.load();
    expect(state1?.events['email:msg-1']).toMatchObject({
      delivered: false,
      pendingChannels: ['hook'],
      lastError: 'n8n down',
    });
    expect(state1?.events['email:msg-2']).toMatchObject({ pendingChannels: ['hook'] });

    fail = false;
    const s2 = await runOnce({ ...opts, sources: [source([])] });
    expect(batches).toEqual([2, 2]);
    expect(webhook.sent).toHaveLength(2); // the non-batch channel was not retried
    expect(s2.deliveries.every((d) => d.ok && d.channel === 'hook')).toBe(true);
    expect((await store.load())?.events['email:msg-2']).toMatchObject({
      delivered: true,
      attempts: 2,
    });
  });

  it('falls back to single sends on a batch channel when the notifier cannot batch', async () => {
    const config = makeConfig({
      channels: { hook: { type: 'slack', webhookUrl: 'https://hooks.slack.com/x' } },
      defaultChannels: ['hook'],
    });
    const { run, slack } = await setup([], { ...config, channels: config.channels });
    await run();
    await run([makeEvent(), makeEvent({ id: 'email:msg-2' })]);
    expect(slack.sent).toHaveLength(2);
  });

  it('tolerates a failing source and reports it', async () => {
    const config = makeConfig();
    const bad: SourceAdapter = {
      name: 'play-api',
      poll: async () => {
        throw new Error('quota');
      },
    };
    const s = await runOnce({
      config,
      sources: [bad, source([makeEvent()])],
      notifiers: new Map(),
      stateStore: new NoneStateStore(),
      logger,
    });
    expect(s.polled).toEqual([
      { source: 'play-api', ok: false, events: 0, error: 'quota' },
      { source: 'email', ok: true, events: 1 },
    ]);
  });

  it('dry-run neither sends nor saves', async () => {
    const { slack, store, run } = await setup([makeEvent()]);
    await run([], false);
    const s = await run([makeEvent({ id: 'email:msg-2' })], true);
    expect(s.deliveries).toEqual([{ eventId: 'email:msg-2', channel: 'slack', ok: true }]);
    expect(slack.sent).toHaveLength(0);
    expect((await store.load())?.events['email:msg-2']).toBeUndefined();
  });
});

describe('runOnce: same fact from two sources', () => {
  const apiRejected = (id = 'api:com.example.app:production:1204:REJECTED') =>
    makeEvent({ id, source: 'play-api', reason: undefined, versionName: undefined });
  const emailRejected = (id = 'email:msg-9') => makeEvent({ id, reason: 'Deceptive Behavior' });

  it('sends the API rejection, then a follow-up when the email brings the reason', async () => {
    const { slack, run, store } = await setup([]);
    await run(); // baseline
    await run([apiRejected()]);
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]?.message.body).not.toContain('Reason:');

    const s = await run([emailRejected()]);
    expect(s.events.map((e) => [e.id, e.followUp])).toEqual([['email:msg-9', true]]);
    expect(slack.sent).toHaveLength(2);
    expect(slack.sent[1]?.message.title).toContain('(reason added)');
    expect(slack.sent[1]?.message.body).toContain('Reason: Deceptive Behavior');
    expect(
      (await store.load())?.events['api:com.example.app:production:1204:REJECTED']?.hasReason,
    ).toBe(true);

    // Another email about the same version is a same-source repeat (a resubmission rejected
    // again, for example) and keeps its own id: it is delivered, not merged.
    const again = await run([emailRejected('email:msg-10')]);
    expect(again.events.map((e) => e.followUp)).toEqual([undefined]);
    expect(slack.sent).toHaveLength(3);
  });

  it('suppresses the API rejection when the email with the reason was already sent', async () => {
    const { slack, run } = await setup([]);
    await run();
    await run([emailRejected()]);
    const s = await run([apiRejected()]);
    expect(s.events).toHaveLength(0);
    expect(slack.sent).toHaveLength(1);
  });

  it('merges both into one notification when they arrive in the same run', async () => {
    const { slack, run } = await setup([]);
    await run();
    const s = await run([apiRejected(), emailRejected()]);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]?.id).toBe('api:com.example.app:production:1204:REJECTED');
    expect(s.events[0]?.reason).toBe('Deceptive Behavior');
    expect(s.events[0]?.versionName).toBe('3.4.2');
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]?.message.body).toContain('Reason: Deceptive Behavior');
  });

  it('honours reasonFollowUp: false', async () => {
    const { slack, run } = await setup([], {
      events: { REJECTED: { enabled: true, reasonFollowUp: false } },
    });
    await run();
    await run([apiRejected()]);
    const s = await run([emailRejected()]);
    expect(s.events).toHaveLength(0);
    expect(slack.sent).toHaveLength(1);
  });
});
