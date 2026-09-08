/**
 * Play Developer API adapter: secondary signal. See docs/PRD_ko.md §5.2.2 and §8.2.
 *
 * STATUS: scaffold. The inference rules are hypotheses until the Phase 0 spike observes real
 * `edits.tracks.get` responses for an app that is under review / rejected / approved.
 */
import type { Config } from '../../core/config';
import type { PollContext, PollResult, SourceAdapter, SourceState } from '../../core/types';

export class PlayApiSourceAdapter implements SourceAdapter {
  readonly name = 'play-api' as const;

  constructor(private readonly cfg: Config['sources']['playApi']) {}

  static fromConfig(config: Config): PlayApiSourceAdapter {
    const cfg = config.sources.playApi;
    if (!cfg.serviceAccountJson) {
      throw new Error(
        'sources.playApi.serviceAccountJson is required when the Play API source is enabled',
      );
    }
    return new PlayApiSourceAdapter(cfg);
  }

  async poll(_ctx: PollContext, _state: SourceState | undefined): Promise<PollResult> {
    // TODO(Phase 2): authenticate with googleapis JWT (androidpublisher scope),
    // edits.insert → edits.tracks.get per app/track → edits.delete, diff versionCodes against
    // state, emit SUBMITTED (medium) and, only when confirmed or emitLiveWithoutConfirmation, LIVE.
    void this.cfg;
    throw new Error('Play API source is not implemented yet (planned for Phase 2; see PRD §5.2.2)');
  }
}
