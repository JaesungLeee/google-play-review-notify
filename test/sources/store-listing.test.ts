import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  StoreListingSourceAdapter,
  parseStoreListing,
  storeListingUrl,
} from '../../src/sources/store-listing';
import type { PollContext, SourceState } from '../../src/core/types';
import { logger, makeConfig } from '../helpers';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', 'fixtures', 'store-listing', name), 'utf8');

const EPOCH = 1788519013; // 2026-09-04

describe('parseStoreListing', () => {
  it('reads the "Updated on" date from a real en/US page excerpt', () => {
    expect(parseStoreListing(fixture('maps-en.html'))).toEqual({
      updatedText: 'Sep 4, 2026',
      updatedAt: EPOCH,
    });
  });

  it('reads the same date from the ko/KR page (locale-independent epoch)', () => {
    expect(parseStoreListing(fixture('maps-ko.html'))).toEqual({
      updatedText: '2026. 9. 4.',
      updatedAt: EPOCH,
    });
  });

  it('falls back to the first data entry when the label markup is missing', () => {
    expect(parseStoreListing('x ["Sep 4, 2026",[1788519013,61000000]] y')).toEqual({
      updatedText: 'Sep 4, 2026',
      updatedAt: EPOCH,
    });
  });

  it('returns nothing for an unrecognized page', () => {
    expect(parseStoreListing('<html>nope</html>')).toEqual({});
  });
});

describe('storeListingUrl', () => {
  it('builds the details URL with locale and country', () => {
    expect(storeListingUrl('com.example.app', 'ko', 'KR')).toBe(
      'https://play.google.com/store/apps/details?id=com.example.app&hl=ko&gl=KR',
    );
  });
});

describe('StoreListingSourceAdapter', () => {
  const config = makeConfig({
    sources: { storeListing: { enabled: true, locale: 'en', country: 'US', failureThreshold: 2 } },
  });

  function page(epoch: number, text = 'Sep 4, 2026') {
    return `<div class="lXlx5">Updated on</div><div class="xg1aie">${text}</div> ... ["${text}",[${epoch},61000000]]`;
  }
  function responder(...responses: Array<Response | Error>) {
    const queue = [...responses];
    return vi.fn<typeof fetch>().mockImplementation(async () => {
      const next = queue.shift();
      if (!next) throw new Error('no more responses');
      if (next instanceof Error) throw next;
      return next;
    });
  }
  const ctx = (baseline = false): PollContext => ({
    logger,
    now: new Date('2026-09-08T10:00:00Z'),
    baseline,
    apps: config.apps,
  });

  it('records only on first sight, then emits LIVE when a 404 listing becomes public', async () => {
    const fetchImpl = responder(
      new Response('Not Found', { status: 404 }),
      new Response('Not Found', { status: 404 }),
      new Response(page(EPOCH), { status: 200 }),
    );
    const adapter = new StoreListingSourceAdapter(config.sources.storeListing, {
      fetchImpl,
      version: '1.2.3',
    });

    const r1 = await adapter.poll(ctx(), undefined);
    expect(r1.events).toEqual([]);
    expect(r1.nextState).toEqual({
      packages: { 'com.example.app': { published: false, failures: 0 } },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(storeListingUrl('com.example.app', 'en', 'US'));
    expect((init?.headers as Record<string, string>)['user-agent']).toBe(
      'google-play-review-notify/1.2.3',
    );

    const r2 = await adapter.poll(ctx(), r1.nextState);
    expect(r2.events).toEqual([]);

    const r3 = await adapter.poll(ctx(), r2.nextState);
    expect(r3.events).toHaveLength(1);
    expect(r3.events[0]).toMatchObject({
      id: `store:com.example.app:${EPOCH}:LIVE`,
      type: 'LIVE',
      packageName: 'com.example.app',
      appName: 'Example App',
      track: 'production',
      source: 'store-listing',
      confidence: 'medium',
      observedAt: '2026-09-08T10:00:00.000Z',
    });
    expect(r3.nextState).toEqual({
      packages: {
        'com.example.app': {
          published: true,
          updatedAt: EPOCH,
          updatedText: 'Sep 4, 2026',
          failures: 0,
        },
      },
    });
  });

  it('emits LIVE when the "Updated on" date changes and stays quiet otherwise', async () => {
    const fetchImpl = responder(
      new Response(page(EPOCH), { status: 200 }),
      new Response(page(EPOCH), { status: 200 }),
      new Response(page(EPOCH + 86_400, 'Sep 5, 2026'), { status: 200 }),
    );
    const adapter = new StoreListingSourceAdapter(config.sources.storeListing, { fetchImpl });

    const r1 = await adapter.poll(ctx(), undefined);
    expect(r1.events).toEqual([]);
    const r2 = await adapter.poll(ctx(), r1.nextState);
    expect(r2.events).toEqual([]);
    const r3 = await adapter.poll(ctx(), r2.nextState);
    expect(r3.events.map((e) => e.id)).toEqual([`store:com.example.app:${EPOCH + 86_400}:LIVE`]);
  });

  it('never emits during a baseline run', async () => {
    const fetchImpl = responder(new Response(page(EPOCH), { status: 200 }));
    const adapter = new StoreListingSourceAdapter(config.sources.storeListing, { fetchImpl });
    const prev: SourceState = {
      packages: { 'com.example.app': { published: false, failures: 0 } },
    };
    const r = await adapter.poll(ctx(true), prev);
    expect(r.events).toEqual([]);
    expect(r.nextState).toMatchObject({ packages: { 'com.example.app': { published: true } } });
  });

  it('counts consecutive failures without throwing and keeps the last good state', async () => {
    const fetchImpl = responder(
      new Response(page(EPOCH), { status: 200 }),
      new Response('<html>changed layout</html>', { status: 200 }),
      new Error('socket hang up'),
      new Error('socket hang up'),
      new Response(page(EPOCH), { status: 200 }),
    );
    const adapter = new StoreListingSourceAdapter(config.sources.storeListing, { fetchImpl });

    const r1 = await adapter.poll(ctx(), undefined);
    const r2 = await adapter.poll(ctx(), r1.nextState); // parse failure
    expect(r2.events).toEqual([]);
    expect(r2.nextState).toMatchObject({
      packages: { 'com.example.app': { published: true, updatedAt: EPOCH, failures: 1 } },
    });
    const r3 = await adapter.poll(ctx(), r2.nextState); // network failure ×2 (retry) → threshold
    expect(r3.nextState).toMatchObject({
      packages: { 'com.example.app': { failures: 2 } },
    });
    const r4 = await adapter.poll(ctx(), r3.nextState); // recovers, same date → no event
    expect(r4.events).toEqual([]);
    expect(r4.nextState).toMatchObject({ packages: { 'com.example.app': { failures: 0 } } });
  });

  it('skips apps that do not include the production track', async () => {
    const fetchImpl = responder();
    const cfg = makeConfig({
      apps: [{ packageName: 'com.example.internal', tracks: ['internal'] }],
      sources: { storeListing: { enabled: true } },
    });
    const adapter = new StoreListingSourceAdapter(cfg.sources.storeListing, { fetchImpl });
    const r = await adapter.poll({ ...ctx(), apps: cfg.apps }, undefined);
    expect(r.events).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
