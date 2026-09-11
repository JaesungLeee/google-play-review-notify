import { describe, expect, it, vi } from 'vitest';
import { PlayApiSourceAdapter, releaseKey, transitionEvents } from '../../src/sources/play-api';
import {
  normalizeReleaseState,
  type PlayApiClient,
  type ReleaseSummary,
} from '../../src/sources/play-api/client';
import { manualEventId } from '../../src/sources/manual';
import type { PollContext } from '../../src/core/types';
import { logger, makeConfig } from '../helpers';

const rel = (state: string, versionCodes: string[] = ['4'], name = '1.1.0'): ReleaseSummary => ({
  name,
  state,
  versionCodes,
});

/** Responses keyed by "<pkg>/<track>", consumed in order per key. */
function client(script: Record<string, Array<ReleaseSummary[] | Error>>): PlayApiClient {
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  return {
    listReleases: vi.fn(async (pkg: string, track: string) => {
      const next = queues[`${pkg}/${track}`]?.shift();
      if (next === undefined) throw new Error(`no scripted response for ${pkg}/${track}`);
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
const adapter = (c: PlayApiClient) => new PlayApiSourceAdapter(config.sources.playApi, c);
const seen = (state: string, versionCodes = ['4'], name = '1.1.0') => ({
  packages: {
    'com.example.app': {
      tracks: {
        production: { releases: { [releaseKey({ versionCodes })]: { state, versionCodes, name } } },
      },
      failures: 0,
    },
  },
});

describe('transitionEvents', () => {
  it.each([
    [undefined, 'DRAFT', []],
    [undefined, 'NOT_SENT_FOR_REVIEW', ['PENDING_SUBMISSION']],
    [undefined, 'IN_REVIEW', ['SUBMITTED']],
    [undefined, 'APPROVED_NOT_PUBLISHED', ['APPROVED']],
    [undefined, 'NOT_APPROVED', ['REJECTED']],
    [undefined, 'PUBLISHED', ['LIVE']],
    ['DRAFT', 'NOT_SENT_FOR_REVIEW', ['PENDING_SUBMISSION']],
    ['NOT_SENT_FOR_REVIEW', 'IN_REVIEW', ['SUBMITTED']],
    ['IN_REVIEW', 'APPROVED_NOT_PUBLISHED', ['APPROVED']],
    ['IN_REVIEW', 'NOT_APPROVED', ['REJECTED']],
    ['IN_REVIEW', 'PUBLISHED', ['APPROVED', 'LIVE']],
    ['NOT_SENT_FOR_REVIEW', 'PUBLISHED', ['APPROVED', 'LIVE']],
    ['APPROVED_NOT_PUBLISHED', 'PUBLISHED', ['LIVE']],
    ['IN_REVIEW', 'IN_REVIEW', []],
    ['PUBLISHED', 'PUBLISHED', []],
    ['IN_REVIEW', 'SOMETHING_NEW', []],
  ])('%s → %s emits %j', (prev, next, expected) => {
    expect(transitionEvents(prev, next)).toEqual(expected);
  });
});

describe('releaseKey / normalizeReleaseState', () => {
  it('identifies a release by its sorted artifacts, or by name without artifacts', () => {
    expect(releaseKey({ versionCodes: ['12', '3'] })).toBe('3+12');
    expect(releaseKey({ name: 'x', versionCodes: [] })).toBe('name:x');
  });
  it('strips the enum prefix and tolerates missing values', () => {
    expect(normalizeReleaseState('RELEASE_LIFECYCLE_STATE_IN_REVIEW')).toBe('IN_REVIEW');
    expect(normalizeReleaseState(undefined)).toBe('UNSPECIFIED');
  });
});

describe('PlayApiSourceAdapter', () => {
  it('records the first observation, then follows a release through the managed-publishing flow', async () => {
    const a = adapter(
      client({
        'com.example.app/production': [
          [rel('IN_REVIEW')],
          [rel('IN_REVIEW')],
          [rel('APPROVED_NOT_PUBLISHED')],
          [rel('PUBLISHED')],
        ],
      }),
    );

    const r1 = await a.poll(ctx(), undefined);
    expect(r1.events).toEqual([]);
    expect(r1.nextState).toEqual(seen('IN_REVIEW'));

    const r2 = await a.poll(ctx(), r1.nextState);
    expect(r2.events).toEqual([]);

    const r3 = await a.poll(ctx(), r2.nextState);
    expect(r3.events).toHaveLength(1);
    expect(r3.events[0]).toMatchObject({
      id: 'api:com.example.app:production:4:APPROVED',
      type: 'APPROVED',
      packageName: 'com.example.app',
      appName: 'Example App',
      track: 'production',
      versionCode: '4',
      versionName: '1.1.0',
      source: 'play-api',
      confidence: 'high',
      observedAt: '2026-09-08T10:00:00.000Z',
    });
    expect(r3.nextState).toEqual(seen('APPROVED_NOT_PUBLISHED'));

    const r4 = await a.poll(ctx(), r3.nextState);
    expect(r4.events.map((e) => e.type)).toEqual(['LIVE']);
  });

  it('emits SUBMITTED for a new release and shares the id with `emit`', async () => {
    const a = adapter(client({ 'com.example.app/production': [[rel('IN_REVIEW')]] }));
    const prev = {
      packages: { 'com.example.app': { tracks: { production: { releases: {} } }, failures: 0 } },
    };
    const r = await a.poll(ctx(), prev);
    expect(r.events.map((e) => e.type)).toEqual(['SUBMITTED']);
    expect(r.events[0]?.id).toBe(
      manualEventId({
        type: 'SUBMITTED',
        packageName: 'com.example.app',
        track: 'production',
        versionCode: '4',
      }),
    );
  });

  it('emits APPROVED and LIVE together when approval publishes at once', async () => {
    const a = adapter(client({ 'com.example.app/production': [[rel('PUBLISHED')]] }));
    const r = await a.poll(ctx(), seen('IN_REVIEW'));
    expect(r.events.map((e) => [e.type, e.id])).toEqual([
      ['APPROVED', 'api:com.example.app:production:4:APPROVED'],
      ['LIVE', 'api:com.example.app:production:4:LIVE'],
    ]);
  });

  it('emits REJECTED without a reason; the email adds it later', async () => {
    const a = adapter(client({ 'com.example.app/production': [[rel('NOT_APPROVED')]] }));
    const r = await a.poll(ctx(), seen('IN_REVIEW'));
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'REJECTED', versionCode: '4' });
    expect(r.events[0]?.reason).toBeUndefined();
  });

  it('uses the highest version code of a multi-artifact release', async () => {
    const a = adapter(client({ 'com.example.app/production': [[rel('IN_REVIEW', ['7', '12'])]] }));
    const r = await a.poll(ctx(), seen('DRAFT', ['7', '12']));
    expect(r.events[0]?.id).toBe('api:com.example.app:production:12:SUBMITTED');
  });

  it('drops a release that is no longer listed without emitting', async () => {
    const a = adapter(client({ 'com.example.app/production': [[]] }));
    const r = await a.poll(ctx(), seen('IN_REVIEW'));
    expect(r.events).toEqual([]);
    expect(r.nextState).toEqual({
      packages: { 'com.example.app': { tracks: { production: { releases: {} } }, failures: 0 } },
    });
  });

  it('never emits during a baseline run', async () => {
    const a = adapter(client({ 'com.example.app/production': [[rel('PUBLISHED')]] }));
    const r = await a.poll(ctx(true), seen('IN_REVIEW'));
    expect(r.events).toEqual([]);
    expect(r.nextState).toEqual(seen('PUBLISHED'));
  });

  it('treats state written by 0.3 (versions instead of releases) as unseen', async () => {
    const a = adapter(client({ 'com.example.app/production': [[rel('PUBLISHED')]] }));
    const legacy = {
      packages: {
        'com.example.app': { tracks: { production: { versions: { '4': '1.1.0' } } }, failures: 0 },
      },
    };
    const r = await a.poll(ctx(), legacy);
    expect(r.events).toEqual([]);
    expect(r.nextState).toEqual(seen('PUBLISHED'));
  });

  it('baselines a track added to the config later', async () => {
    const two = makeConfig({
      apps: [{ packageName: 'com.example.app', tracks: ['production', 'internal'] }],
      sources: { playApi: { enabled: true, serviceAccountJson: '{}' } },
    });
    const a = new PlayApiSourceAdapter(
      two.sources.playApi,
      client({
        'com.example.app/production': [[rel('PUBLISHED')]],
        'com.example.app/internal': [[rel('PUBLISHED', ['9'], '1.2.0')]],
      }),
    );
    const r = await a.poll({ ...ctx(), apps: two.apps }, seen('APPROVED_NOT_PUBLISHED'));
    expect(r.events.map((e) => [e.type, e.track])).toEqual([['LIVE', 'production']]);
    expect(r.nextState).toMatchObject({
      packages: {
        'com.example.app': {
          tracks: { internal: { releases: { '9': { state: 'PUBLISHED', versionCodes: ['9'] } } } },
        },
      },
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
    const a = new PlayApiSourceAdapter(
      two.sources.playApi,
      client({
        'com.example.app/production': [new Error('403 insufficient permissions')],
        'com.example.other/production': [[rel('IN_REVIEW', ['7'], '2.0.0')]],
      }),
    );
    const r = await a.poll({ ...ctx(), apps: two.apps }, seen('IN_REVIEW'));
    expect(r.events).toEqual([]);
    expect(r.nextState).toEqual({
      packages: {
        'com.example.app': { ...seen('IN_REVIEW').packages['com.example.app'], failures: 1 },
        'com.example.other': {
          tracks: {
            production: {
              releases: { '7': { state: 'IN_REVIEW', versionCodes: ['7'], name: '2.0.0' } },
            },
          },
          failures: 0,
        },
      },
    });
  });

  it('throws when every app fails so the run summary shows the source as failed', async () => {
    const a = adapter(client({ 'com.example.app/production': [new Error('invalid_grant')] }));
    await expect(a.poll(ctx(), undefined)).rejects.toThrow('invalid_grant');
  });

  it('fromConfig requires a service account', () => {
    expect(() => PlayApiSourceAdapter.fromConfig(makeConfig())).toThrow('serviceAccountJson');
  });
});
