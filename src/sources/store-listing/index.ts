/**
 * Public Play Store listing adapter: optional LIVE confirmation. See docs/PRD_ko.md §5.2.3.
 * STATUS: scaffold (Phase 3). Unofficial HTML parsing; failures must never abort a run.
 */
import type { Config } from '../../core/config';
import type { PollContext, PollResult, SourceAdapter, SourceState } from '../../core/types';

export class StoreListingSourceAdapter implements SourceAdapter {
  readonly name = 'store-listing' as const;

  constructor(private readonly cfg: Config['sources']['storeListing']) {}

  static fromConfig(config: Config): StoreListingSourceAdapter {
    return new StoreListingSourceAdapter(config.sources.storeListing);
  }

  async poll(_ctx: PollContext, _state: SourceState | undefined): Promise<PollResult> {
    // TODO(Phase 3): GET https://play.google.com/store/apps/details?id=<pkg>&hl=<locale>&gl=<country>,
    // extract version name + "Updated on", emit LIVE (medium) on change, count consecutive failures.
    void this.cfg;
    throw new Error(
      'Store listing source is not implemented yet (planned for Phase 3; see PRD §5.2.3)',
    );
  }
}
