/** Manual/external trigger source: wraps events handed in by `emit` or the Action input. §5.2.4 */
import type {
  PollContext,
  PollResult,
  ReviewEvent,
  SourceAdapter,
  SourceState,
} from '../../core/types';

export class ManualSourceAdapter implements SourceAdapter {
  readonly name = 'manual' as const;
  constructor(private readonly events: ReviewEvent[]) {}

  async poll(_ctx: PollContext, state: SourceState | undefined): Promise<PollResult> {
    return { events: this.events, nextState: state ?? {} };
  }
}

export function manualEventId(
  e: Pick<ReviewEvent, 'type' | 'packageName' | 'track' | 'versionCode'>,
): string {
  // Same key shape as the Play API adapter so the two never duplicate (FR-SRC-MANUAL-1).
  return `api:${e.packageName ?? 'unknown'}:${e.track ?? 'production'}:${e.versionCode ?? 'unknown'}:${e.type}`;
}
