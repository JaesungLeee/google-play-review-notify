import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyState, migrateState, pruneEvents } from '../../src/core/state';
import { FileStateStore } from '../../src/state/file';
import { GithubCacheStateStore } from '../../src/state/github-cache';

describe('FileStateStore', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('returns null when missing or corrupt, round-trips otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prn-'));
    dirs.push(dir);
    const store = new FileStateStore(join(dir, 'nested', 'state.json'));
    expect(await store.load()).toBeNull();
    const s = createEmptyState(new Date('2026-01-01T00:00:00Z'));
    s.events['x'] = {
      type: 'APPROVED',
      packageName: 'a',
      at: s.updatedAt,
      delivered: true,
      attempts: 1,
    };
    await store.save(s);
    expect(await store.load()).toEqual(s);
  });
});

describe('GithubCacheStateStore', () => {
  it('restores by prefix and saves under a unique key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prn-cache-'));
    const cache = { restoreCache: vi.fn(async () => undefined), saveCache: vi.fn(async () => 1) };
    const store = new GithubCacheStateStore({
      dir,
      cache,
      runId: '42',
      attempt: '1',
      keyPrefix: 'p',
    });
    expect(await store.load()).toBeNull();
    expect(cache.restoreCache).toHaveBeenCalledWith([join(dir, 'state.json')], 'p-42-', ['p-']);
    await store.save(createEmptyState());
    expect(String(cache.saveCache.mock.calls[0]![1])).toMatch(/^p-42-1-\d+$/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('state helpers', () => {
  it('migrateState rejects unknown versions', () => {
    expect(migrateState({ schemaVersion: 99 })).toBeNull();
    expect(migrateState('nope')).toBeNull();
    expect(migrateState({ schemaVersion: 1 })).toMatchObject({
      schemaVersion: 1,
      sources: {},
      events: {},
    });
  });
  it('pruneEvents keeps undelivered and recent delivered records only', () => {
    const now = new Date('2026-09-07T00:00:00Z');
    const s = createEmptyState(now);
    s.events['old'] = {
      type: 'APPROVED',
      packageName: 'a',
      at: '2026-01-01T00:00:00Z',
      delivered: true,
      attempts: 1,
    };
    s.events['oldPending'] = {
      type: 'APPROVED',
      packageName: 'a',
      at: '2026-01-01T00:00:00Z',
      delivered: false,
      attempts: 1,
    };
    s.events['new'] = {
      type: 'APPROVED',
      packageName: 'a',
      at: '2026-09-06T00:00:00Z',
      delivered: true,
      attempts: 1,
    };
    expect(Object.keys(pruneEvents(s, now).events).sort()).toEqual(['new', 'oldPending']);
  });
});
