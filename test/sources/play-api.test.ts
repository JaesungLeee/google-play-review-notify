import { describe, expect, it, vi } from 'vitest';
import { PlayApiSourceAdapter } from '../../src/sources/play-api';
import type { PlayApiClient, TrackSnapshot } from '../../src/sources/play-api/client';
import { manualEventId } from '../../src/sources/manual';
import type { PollContext } from '../../src/core/types';
import { logger, makeConfig } from '../helpers';

/** Shape observed in the Phase 0 snapshot: the release under review is already `completed`. */
function tracks(production: string[], internal: string[] = [], name = '1.0.0'): TrackSnapshot[] {
  return [
    {
      track: 'production',
      releases: production.length ? [{ name, status: 'completed', versionCodes: production }] : [],
    },
    { track: 'beta', releases: [] },
    { track: 'alpha', releases: [] },
    {
      track: 'internal',
      releases: internal.length ? [{ name, status: 'completed', versionCodes: internal }] : [],
    },
  ];
}

function client(...responses: Array<TrackSnapshot[] | Error>): PlayApiClient {
  const queue = [...responses];
  return {
    listTracks: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error('no more responses');
      if (next instanceof Error) throw next;
      return next;
    }),
  };
}

const config = makeConfig({
  apps: [{ packageName: 'com.example.app', name: 'Example App', tracks: ['production'] }],
  sources: { playApi: { enabled: true, serviceAccountJson: '{}' } },
});
const ctx = (baseline = false): PollContext => ({
  logger,
  now: new Date('2026-09-08T10:00:00Z'),
  baseline,
  apps: config.apps,
});

describe('PlayApiSourceAdapter', () => {
  it('records the first observation, then emits SUBMITTED for a new versionCode', async () => {
    const adapter = new PlayApiSourceAdapter(
      config.sources.playApi,
      client(tracks(['3'], ['3']), tracks(['3'], ['3']), tracks(['4'], ['4'], '1.1.0')),
    );

    const r1 = await adapter.poll(ctx(), undefined);
    expect(r1.events).toEqual([]);
    expect(r1.nextState).toEqual({
      packages: {
        'com.example.app': {
          // Only configured tracks are kept.
          tracks: { production: { versions: { '3': '1.0.0' } } },
          failures: 0,
        },
      },
    });

    const r2 = await adapter.poll(ctx(), r1.nextState);
    expect(r2.events).toEqual([]);

    const r3 = await adapter.poll(ctx(), r2.nextState);
    expect(r3.events).toHaveLength(1);
    expect(r3.events[0]).toMatchObject({
      id: 'api:com.example.app:production:4:SUBMITTED',
      type: 'SUBMITTED',
      packageName: 'com.example.app',
      appName: 'Example App',
      track: 'production',
      versionCode: '4',
      versionName: '1.1.0',
      source: 'play-api',
      confidence: 'medium',
      observedAt: '2026-09-08T10:00:00.000Z',
    });
    // Same id as `emit --type SUBMITTED` so the two never duplicate.
    expect(r3.events[0]?.id).toBe(
      manualEventId({
        type: 'SUBMITTED',
        packageName: 'com.example.app',
        track: 'production',
        versionCode: '4',
      }),
    );
    expect(r3.nextState).toMatchObject({
      packages: { 'com.example.app': { tracks: { production: { versions: { '4': '1.1.0' } } } } },
    });
  });

  it('never emits during a baseline run', async () => {
    const adapter = new PlayApiSourceAdapter(config.sources.playApi, client(tracks(['9'])));
    const prev = {
      packages: {
        'com.example.app': { tracks: { production: { versions: { '3': '1.0.0' } } }, failures: 0 },
      },
    };
    const r = await adapter.poll(ctx(true), prev);
    expect(r.events).toEqual([]);
    expect(r.nextState).toMatchObject({
      packages: { 'com.example.app': { tracks: { production: { versions: { '9': '1.0.0' } } } } },
    });
  });

  it('does not emit LIVE unless emitLiveWithoutConfirmation is set', async () => {
    const withLive = makeConfig({
      apps: config.apps,
      sources: {
        playApi: { enabled: true, serviceAccountJson: '{}', emitLiveWithoutConfirmation: true },
      },
    });
    const prev = {
      packages: {
        'com.example.app': { tracks: { production: { versions: { '3': '1.0.0' } } }, failures: 0 },
      },
    };

    const quiet = new PlayApiSourceAdapter(config.sources.playApi, client(tracks(['4'])));
    expect((await quiet.poll(ctx(), prev)).events.map((e) => e.type)).toEqual(['SUBMITTED']);

    const loud = new PlayApiSourceAdapter(withLive.sources.playApi, client(tracks(['4'])));
    const r = await loud.poll(ctx(), prev);
    expect(r.events.map((e) => [e.type, e.confidence])).toEqual([
      ['SUBMITTED', 'medium'],
      ['LIVE', 'low'],
    ]);
    expect(r.events[1]?.id).toBe('api:com.example.app:production:4:LIVE');
  });

  it('logs a disappeared versionCode as a rejection candidate without emitting', async () => {
    const info = vi.fn();
    const adapter = new PlayApiSourceAdapter(config.sources.playApi, client(tracks([])));
    const prev = {
      packages: {
        'com.example.app': { tracks: { production: { versions: { '3': '1.0.0' } } }, failures: 0 },
      },
    };
    const r = await adapter.poll({ ...ctx(), logger: { ...logger, info } }, prev);
    expect(r.events).toEqual([]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('rejection candidate'));
    expect(r.nextState).toMatchObject({
      packages: { 'com.example.app': { tracks: { production: { versions: {} } } } },
    });
  });

  it('keeps the previous state and counts failures when one app fails', async () => {
    const two = makeConfig({
      apps: [
        { packageName: 'com.example.app', tracks: ['production'] },
        { packageName: 'com.example.other', tracks: ['production'] },
      ],
      sources: { playApi: { enabled: true, serviceAccountJson: '{}' } },
    });
    const adapter = new PlayApiSourceAdapter(
      two.sources.playApi,
      client(new Error('403 insufficient permissions'), tracks(['7'])),
    );
    const prev = {
      packages: {
        'com.example.app': { tracks: { production: { versions: { '3': '1.0.0' } } }, failures: 0 },
      },
    };
    const r = await adapter.poll({ ...ctx(), apps: two.apps }, prev);
    expect(r.events).toEqual([]);
    expect(r.nextState).toEqual({
      packages: {
        'com.example.app': { tracks: { production: { versions: { '3': '1.0.0' } } }, failures: 1 },
        'com.example.other': {
          tracks: { production: { versions: { '7': '1.0.0' } } },
          failures: 0,
        },
      },
    });
  });

  it('throws when every app fails so the run summary shows the source as failed', async () => {
    const adapter = new PlayApiSourceAdapter(
      config.sources.playApi,
      client(new Error('invalid_grant')),
    );
    await expect(adapter.poll(ctx(), undefined)).rejects.toThrow('invalid_grant');
  });

  it('fromConfig requires a service account', () => {
    expect(() => PlayApiSourceAdapter.fromConfig(makeConfig())).toThrow('serviceAccountJson');
  });
});
