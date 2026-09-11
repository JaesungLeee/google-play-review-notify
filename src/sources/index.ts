import type { Config } from '../core/config';
import type { Logger, SourceAdapter } from '../core/types';
import { EmailSourceAdapter } from './email';
import { PlayApiSourceAdapter } from './play-api';

export { EmailSourceAdapter, PlayApiSourceAdapter };
export { ManualSourceAdapter, manualEventId } from './manual';

export function createSources(config: Config, logger: Logger): SourceAdapter[] {
  const out: SourceAdapter[] = [];
  if (config.sources.email.enabled) out.push(EmailSourceAdapter.fromConfig(config));
  if (config.sources.playApi.enabled) out.push(PlayApiSourceAdapter.fromConfig(config));
  if (out.length === 0) logger.warn('No sources enabled; nothing will be detected');
  return out;
}
