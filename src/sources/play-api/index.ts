/**
 * Play Developer API adapter: SUBMITTED detection. See docs/PRD_ko.md §5.2.2 and §8.2.
 *
 * Phase 0 (docs/PRD_ko.md §8.2) established what the API can and cannot tell us:
 *   - a release appears in `tracks.list` as soon as it is submitted, already with
 *     `status: completed`, even while it is still under review → a new versionCode in a
 *     configured track means SUBMITTED (confidence medium);
 *   - the same field never changes on approval, so the API alone cannot report LIVE. LIVE comes
 *     from the store listing adapter; `emitLiveWithoutConfirmation` opts into a low-confidence
 *     LIVE for users without a public listing;
 *   - a versionCode that disappears without a higher replacement is only a rejection candidate
 *     and is logged, never notified (the rejection email carries the real signal).
 *
 * Event ids use the same shape as `emit` (`api:<pkg>:<track>:<versionCode>:<TYPE>`) so a
 * pipeline that emits SUBMITTED right after upload never duplicates this adapter.
 */
import type { Config } from '../../core/config';
import type {
  AppRef,
  PollContext,
  PollResult,
  ReviewEvent,
  SourceAdapter,
  SourceState,
} from '../../core/types';
import { consoleUrlFor } from '../email';
import { manualEventId } from '../manual';
import { createPlayApiClient, type PlayApiClient, type TrackSnapshot } from './client';

interface TrackState {
  /** versionCode → release name, for every release currently on the track. */
  versions: Record<string, string | null>;
}

interface PackageState {
  tracks: Record<string, TrackState>;
  failures: number;
}

interface PlayApiState extends SourceState {
  packages: Record<string, PackageState>;
}

export class PlayApiSourceAdapter implements SourceAdapter {
  readonly name = 'play-api' as const;

  constructor(
    private readonly cfg: Config['sources']['playApi'],
    private readonly client: PlayApiClient,
  ) {}

  static fromConfig(config: Config): PlayApiSourceAdapter {
    const cfg = config.sources.playApi;
    if (!cfg.serviceAccountJson) {
      throw new Error(
        'sources.playApi.serviceAccountJson is required when the Play API source is enabled',
      );
    }
    return new PlayApiSourceAdapter(cfg, createPlayApiClient(cfg.serviceAccountJson));
  }

  async poll(ctx: PollContext, prev: SourceState | undefined): Promise<PollResult> {
    const previous = (prev as PlayApiState | undefined)?.packages ?? {};
    const packages: Record<string, PackageState> = { ...previous };
    const events: ReviewEvent[] = [];
    const errors: string[] = [];

    for (const app of ctx.apps) {
      const pkg = app.packageName;
      const before = previous[pkg];
      let tracks: TrackSnapshot[];
      try {
        tracks = await this.client.listTracks(pkg);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${pkg}: ${msg}`);
        ctx.logger.warn(`Play API ${pkg}: tracks.list failed: ${msg}`);
        packages[pkg] = { tracks: before?.tracks ?? {}, failures: (before?.failures ?? 0) + 1 };
        continue;
      }

      const now: PackageState = { tracks: {}, failures: 0 };
      for (const t of tracks.filter((t) => app.tracks.includes(t.track))) {
        now.tracks[t.track] = snapshotTrack(t);
      }
      packages[pkg] = now;
      // First sight of this package or a global baseline run: record only.
      if (!before || ctx.baseline) continue;

      for (const track of app.tracks) {
        const seen = before.tracks[track]?.versions;
        const current = now.tracks[track]?.versions ?? {};
        // Track not observed before (added to config later): baseline it silently.
        if (!seen) continue;

        const added = Object.keys(current).filter((v) => !(v in seen));
        const removed = Object.keys(seen).filter((v) => !(v in current));
        const highestNow = Math.max(0, ...Object.keys(current).map(Number));

        for (const versionCode of added) {
          const release = tracks
            .find((t) => t.track === track)
            ?.releases.find((r) => r.versionCodes.includes(versionCode));
          events.push(
            this.event(ctx, app, track, versionCode, 'SUBMITTED', 'medium', release?.name),
          );
          if (
            this.cfg.emitLiveWithoutConfirmation &&
            (release?.status === 'completed' || release?.status === 'inProgress')
          ) {
            events.push(this.event(ctx, app, track, versionCode, 'LIVE', 'low', release?.name));
          }
        }
        for (const versionCode of removed) {
          if (Number(versionCode) >= highestNow) {
            ctx.logger.info(
              `Play API ${pkg}/${track}: versionCode ${versionCode} disappeared without a higher ` +
                'replacement (rejection candidate; waiting for the email to confirm)',
            );
          }
        }
      }
    }

    if (errors.length && errors.length === ctx.apps.length) {
      throw new Error(`Play API failed for every app: ${errors.join('; ')}`);
    }
    return { events, nextState: { packages } satisfies PlayApiState };
  }

  private event(
    ctx: PollContext,
    app: AppRef,
    track: string,
    versionCode: string,
    type: 'SUBMITTED' | 'LIVE',
    confidence: ReviewEvent['confidence'],
    versionName: string | undefined,
  ): ReviewEvent {
    const ev: ReviewEvent = {
      id: manualEventId({ type, packageName: app.packageName, track, versionCode }),
      type,
      packageName: app.packageName,
      track,
      versionCode,
      source: 'play-api',
      confidence,
      observedAt: ctx.now.toISOString(),
      consoleUrl: consoleUrlFor(app.packageName),
    };
    if (app.name) ev.appName = app.name;
    if (versionName) ev.versionName = versionName;
    return ev;
  }
}

function snapshotTrack(t: TrackSnapshot): TrackState {
  const versions: Record<string, string | null> = {};
  for (const r of t.releases) {
    for (const v of r.versionCodes) versions[v] = r.name ?? null;
  }
  return { versions };
}
