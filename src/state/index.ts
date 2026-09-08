import { resolve } from 'node:path';
import type { Config } from '../core/config';
import type { Logger, StateStore } from '../core/types';
import { FileStateStore } from './file';
import { GithubCacheStateStore } from './github-cache';
import { NoneStateStore } from './none';

export { FileStateStore, GithubCacheStateStore, NoneStateStore };

export async function createStateStore(config: Config, logger: Logger): Promise<StateStore> {
  const cfg = config.stateStore;
  switch (cfg.type) {
    case 'file':
      return new FileStateStore(cfg.path);
    case 'github-cache':
      return new GithubCacheStateStore({ keyPrefix: cfg.keyPrefix, logger });
    case 'none':
      return new NoneStateStore();
    case 'custom': {
      // FR-STATE-3: user module exporting `createStateStore(): StateStore` or a default StateStore instance.
      const mod = (await import(resolve(cfg.module))) as {
        default?: StateStore | (() => StateStore);
        createStateStore?: () => StateStore;
      };
      const store =
        mod.createStateStore?.() ??
        (typeof mod.default === 'function' ? mod.default() : mod.default);
      if (!store || typeof store.load !== 'function') {
        throw new Error(`Custom state store module ${cfg.module} does not export a StateStore`);
      }
      return store;
    }
  }
}
