import type { Config } from '../core/config';
import type { Logger, SourceAdapter } from '../core/types';
import { EmailSourceAdapter } from './email';
import { PlayApiSourceAdapter } from './play-api';
import { StoreListingSourceAdapter } from './store-listing';

export { EmailSourceAdapter, PlayApiSourceAdapter, StoreListingSourceAdapter };
export { ManualSourceAdapter, manualEventId } from './manual';

export interface SourceOptions {
  /** Package version, used in outbound User-Agent headers. */
  version?: string;
}

export function createSources(
  config: Config,
  logger: Logger,
  opts: SourceOptions = {},
): SourceAdapter[] {
  const out: SourceAdapter[] = [];
  if (config.sources.email.enabled) out.push(EmailSourceAdapter.fromConfig(config));
  if (config.sources.playApi.enabled) out.push(PlayApiSourceAdapter.fromConfig(config));
  if (config.sources.storeListing.enabled)
    out.push(StoreListingSourceAdapter.fromConfig(config, opts));
  if (out.length === 0) logger.warn('No sources enabled; nothing will be detected');
  return out;
}
