/**
 * Play Developer API adapter: release lifecycle transitions. See docs/design.md, "Play API
 * transition table".
 *
 * `applications.tracks.releases.list` reports each release's `releaseLifecycleState`
 * (DRAFT → NOT_SENT_FOR_REVIEW → IN_REVIEW → APPROVED_NOT_PUBLISHED | NOT_APPROVED → PUBLISHED).
 * The adapter remembers the last state per release and emits one event per state entered:
 *
 *   NOT_SENT_FOR_REVIEW     → PENDING_SUBMISSION
 *   IN_REVIEW               → SUBMITTED
 *   APPROVED_NOT_PUBLISHED  → APPROVED   (managed publishing: approved, waiting for Publish)
 *   NOT_APPROVED            → REJECTED   (the rejection email later adds the reason)
 *   PUBLISHED               → LIVE, preceded by APPROVED when the approval itself was not
 *                             observed (managed publishing off: approval publishes at once)
 *
 * A release that disappears (superseded, obsolete) is dropped from state without an event.
 * Event ids use the same shape as `emit` (`api:<pkg>:<track>:<versionCode>:<TYPE>`) so a
 * pipeline that emits SUBMITTED right after upload never duplicates this adapter.
 */
import type { Config } from '../../core/config';
import type {
  AppRef,
  PollContext,
  PollResult,
  ReviewEvent,
  ReviewEventType,
  SourceAdapter,
  SourceState,
} from '../../core/types';
import { consoleUrlFor } from '../email';
import { manualEventId } from '../manual';
import { createPlayApiClient, type PlayApiClient, type ReleaseSummary } from './client';

export interface ReleaseState {
  state: string;
  versionCodes: string[];
  name?: string;
}

interface TrackState {
  /** Release key (see `releaseKey`) → last observed release. */
  releases: Record<string, ReleaseState>;
}

interface PackageState {
  tracks: Record<string, TrackState>;
  /** Consecutive polls in which every configured track failed. */
  failures: number;
}

interface PlayApiState extends SourceState {
  packages: Record<string, PackageState>;
}

/** Releases are identified by their artifacts; a release with none falls back to its name. */
export function releaseKey(r: Pick<ReleaseSummary, 'name' | 'versionCodes'>): string {
  const codes = [...r.versionCodes].sort((a, b) => Number(a) - Number(b));
  return codes.length ? codes.join('+') : `name:${r.name ?? ''}`;
}

/** Events to emit when a release moves from `prev` (undefined: first sight) to `next`. */
export function transitionEvents(prev: string | undefined, next: string): ReviewEventType[] {
  if (prev === next) return [];
  switch (next) {
    case 'NOT_SENT_FOR_REVIEW':
      return ['PENDING_SUBMISSION'];
    case 'IN_REVIEW':
      return ['SUBMITTED'];
    case 'APPROVED_NOT_PUBLISHED':
      return ['APPROVED'];
    case 'NOT_APPROVED':
      return ['REJECTED'];
    case 'PUBLISHED':
      // First sight of an already published release says nothing about its review.
      if (prev === undefined || prev === 'APPROVED_NOT_PUBLISHED') return ['LIVE'];
      return ['APPROVED', 'LIVE'];
    default:
      return [];
  }
}

export class PlayApiSourceAdapter implements SourceAdapter {
  readonly name = 'play-api' as const;

  constructor(
    _cfg: Config['sources']['playApi'],
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
    let failedApps = 0;
    const errors: string[] = [];

    for (const app of ctx.apps) {
      const pkg = app.packageName;
      const before = previous[pkg];
      const now: PackageState = { tracks: {}, failures: 0 };
      let failedTracks = 0;

      for (const track of app.tracks) {
        // A track state written by 0.4 or earlier has `versions` instead of `releases`: treat as unseen.
        const seen = before?.tracks[track]?.releases;
        let releases: ReleaseSummary[];
        try {
          releases = await this.client.listReleases(pkg, track);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failedTracks += 1;
          errors.push(`${pkg}/${track}: ${msg}`);
          ctx.logger.warn(`Play API ${pkg}/${track}: releases.list failed: ${msg}`);
          if (seen) now.tracks[track] = { releases: seen };
          continue;
        }

        const current: TrackState = { releases: {} };
        for (const r of releases) {
          const key = releaseKey(r);
          const rs: ReleaseState = { state: r.state, versionCodes: r.versionCodes };
          if (r.name) rs.name = r.name;
          current.releases[key] = rs;
        }
        now.tracks[track] = current;

        // First sight of this package/track or a global baseline run: record only.
        if (!before || !seen || ctx.baseline) continue;

        for (const [key, rel] of Object.entries(current.releases)) {
          const was = seen[key]?.state;
          for (const type of transitionEvents(was, rel.state)) {
            events.push(this.event(ctx, app, track, rel, type));
          }
          if (was !== rel.state) {
            ctx.logger.debug(
              `Play API ${pkg}/${track}: release ${rel.name ?? key} ${was ?? '(new)'} → ${rel.state}`,
            );
          }
        }
        for (const key of Object.keys(seen)) {
          if (!(key in current.releases)) {
            ctx.logger.debug(`Play API ${pkg}/${track}: release ${key} no longer listed`);
          }
        }
      }

      if (app.tracks.length && failedTracks === app.tracks.length) {
        failedApps += 1;
        now.failures = (before?.failures ?? 0) + 1;
      }
      packages[pkg] = now;
    }

    if (ctx.apps.length && failedApps === ctx.apps.length) {
      throw new Error(`Play API failed for every app: ${errors.join('; ')}`);
    }
    return { events, nextState: { packages } satisfies PlayApiState };
  }

  private event(
    ctx: PollContext,
    app: AppRef,
    track: string,
    rel: ReleaseState,
    type: ReviewEventType,
  ): ReviewEvent {
    const versionCode = rel.versionCodes.length
      ? String(Math.max(...rel.versionCodes.map(Number)))
      : undefined;
    const ev: ReviewEvent = {
      id: manualEventId({
        type,
        packageName: app.packageName,
        track,
        ...(versionCode !== undefined ? { versionCode } : {}),
      }),
      type,
      packageName: app.packageName,
      track,
      source: 'play-api',
      confidence: 'high',
      observedAt: ctx.now.toISOString(),
      consoleUrl: consoleUrlFor(app.packageName),
    };
    if (versionCode !== undefined) ev.versionCode = versionCode;
    if (app.name) ev.appName = app.name;
    if (rel.name) ev.versionName = rel.name;
    return ev;
  }
}
