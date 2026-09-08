/**
 * GitHub Actions Cache backed store. Cache entries are immutable, so every save uses a fresh key
 * (`<prefix>-<runId>-<attempt>-<ts>`) and load restores the newest entry matching `<prefix>-`.
 * Entries unused for 7 days are evicted by GitHub → the next run baselines.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrateState } from '../core/state';
import type { Logger, State, StateStore } from '../core/types';

/** Subset of @actions/cache used here (kept explicit so tests can inject a fake). */
export interface CacheApi {
  restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[],
  ): Promise<string | undefined>;
  saveCache(paths: string[], key: string): Promise<number>;
}

export interface GithubCacheStateStoreOptions {
  keyPrefix?: string;
  /** Directory that holds the cached state file (must be inside the workspace). */
  dir?: string;
  logger?: Logger;
  /** Injected for tests. */
  cache?: CacheApi;
  runId?: string;
  attempt?: string;
}

export class GithubCacheStateStore implements StateStore {
  readonly name = 'github-cache';
  private readonly prefix: string;
  private readonly dir: string;
  private readonly file: string;
  private readonly cacheImpl: CacheApi | undefined;
  private readonly logger: Logger | undefined;
  private readonly runId: string;
  private readonly attempt: string;

  constructor(opts: GithubCacheStateStoreOptions = {}) {
    this.prefix = opts.keyPrefix ?? 'play-review-notify-state';
    this.dir = opts.dir ?? join(process.env['RUNNER_TEMP'] ?? process.cwd(), '.play-review-notify');
    this.file = join(this.dir, 'state.json');
    this.cacheImpl = opts.cache;
    this.logger = opts.logger;
    this.runId = opts.runId ?? process.env['GITHUB_RUN_ID'] ?? String(Date.now());
    this.attempt = opts.attempt ?? process.env['GITHUB_RUN_ATTEMPT'] ?? '1';
  }

  private async cache(): Promise<CacheApi> {
    if (this.cacheImpl) return this.cacheImpl;
    return import('@actions/cache');
  }

  async load(): Promise<State | null> {
    mkdirSync(this.dir, { recursive: true });
    const c = await this.cache();
    const hit = await c.restoreCache([this.file], `${this.prefix}-${this.runId}-`, [
      `${this.prefix}-`,
    ]);
    if (!hit) {
      this.logger?.info(`No cache entry matching "${this.prefix}-" found`);
      return null;
    }
    this.logger?.debug(`Restored state from cache key ${hit}`);
    try {
      return migrateState(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return null;
    }
  }

  async save(state: State): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(state), 'utf8');
    const key = `${this.prefix}-${this.runId}-${this.attempt}-${Date.now()}`;
    const c = await this.cache();
    await c.saveCache([this.file], key);
    this.logger?.debug(`Saved state to cache key ${key}`);
  }
}
