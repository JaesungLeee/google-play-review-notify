/**
 * Public Play Store listing adapter: LIVE confirmation for the production track.
 * See docs/design.md, "What each signal can and cannot say".
 *
 * Validation showed that the Play Developer API reports a release as `completed` while it is
 * still under review, and that Google sends no approval email. The public listing is
 * therefore the only signal that a version actually reached users:
 *
 *   - listing 404 → 200         : first release went live
 *   - "Updated on" date changed : an update went live
 *
 * Unofficial HTML parsing: failures are counted and logged but never abort a run.
 */
import type { Config } from '../../core/config';
import { fetchWithRetry, HttpError } from '../../core/http';
import type {
  AppRef,
  PollContext,
  PollResult,
  ReviewEvent,
  SourceAdapter,
  SourceState,
} from '../../core/types';
import { consoleUrlFor } from '../email';

export interface StoreListingInfo {
  /** Unix epoch seconds of the "Updated on" date, as embedded in the page data. */
  updatedAt?: number;
  /** Localized "Updated on" text as displayed, e.g. "Sep 4, 2026" or "2026. 9. 4.". */
  updatedText?: string;
}

interface PackageState {
  published: boolean;
  updatedAt?: number;
  updatedText?: string;
  /** Consecutive fetch/parse failures. */
  failures: number;
}

interface StoreListingState extends SourceState {
  packages: Record<string, PackageState>;
}

export interface StoreListingOptions {
  fetchImpl?: typeof fetch;
  version?: string;
  timeoutMs?: number;
}

export function storeListingUrl(packageName: string, locale: string, country: string): string {
  const q = new URLSearchParams({ id: packageName, hl: locale, gl: country });
  return `https://play.google.com/store/apps/details?${q.toString()}`;
}

/**
 * Extracts the "Updated on" date. The visible label is localized, but the page data embeds the
 * same date as `"<text>",[<epochSeconds>,<nanos>]`, which is locale-independent. When the label
 * is found its text is used to pick the matching data entry; otherwise the first entry wins.
 */
export function parseStoreListing(html: string): StoreListingInfo {
  const label = /class="lXlx5">[^<]*<\/div><div class="xg1aie">([^<]+)<\/div>/.exec(html)?.[1];
  const entry = (text: string | undefined): RegExpExecArray | null => {
    const pattern = text
      ? `"(${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})",\\[(\\d{9,10}),\\d+\\]`
      : `"([^"]{6,30})",\\[(\\d{9,10}),\\d+\\]`;
    return new RegExp(pattern).exec(html);
  };
  const m = (label && entry(label)) || entry(undefined);
  const text = m?.[1];
  const epoch = m?.[2];
  const info: StoreListingInfo = {};
  if (text !== undefined && epoch !== undefined) {
    info.updatedText = text;
    info.updatedAt = Number(epoch);
  } else if (label) {
    info.updatedText = label;
  }
  return info;
}

type Observation = { ok: true; state: PackageState } | { ok: false; state: PackageState };

export class StoreListingSourceAdapter implements SourceAdapter {
  readonly name = 'store-listing' as const;

  constructor(
    private readonly cfg: Config['sources']['storeListing'],
    private readonly opts: StoreListingOptions = {},
  ) {}

  static fromConfig(config: Config, opts: StoreListingOptions = {}): StoreListingSourceAdapter {
    return new StoreListingSourceAdapter(config.sources.storeListing, opts);
  }

  async poll(ctx: PollContext, prev: SourceState | undefined): Promise<PollResult> {
    const previous = (prev as StoreListingState | undefined)?.packages ?? {};
    const packages: Record<string, PackageState> = { ...previous };
    const events: ReviewEvent[] = [];

    for (const app of ctx.apps.filter((a) => a.tracks.includes('production'))) {
      const pkg = app.packageName;
      const before = previous[pkg];
      const result = await this.observe(ctx, pkg, before);
      packages[pkg] = result.state;
      // Failure, first sight of this package, or a global baseline run: record only.
      if (!result.ok || !before || ctx.baseline) continue;

      const now = result.state;
      const wentLive = !before.published && now.published;
      const updated =
        before.published &&
        now.published &&
        now.updatedAt !== undefined &&
        before.updatedAt !== undefined &&
        now.updatedAt !== before.updatedAt;

      if (wentLive || updated) {
        events.push(this.liveEvent(ctx, app, now));
      } else if (before.published && !now.published) {
        ctx.logger.warn(`Store listing for ${pkg} disappeared (404); not emitting an event`);
      }
    }

    return { events, nextState: { packages } satisfies StoreListingState };
  }

  private async observe(
    ctx: PollContext,
    pkg: string,
    before: PackageState | undefined,
  ): Promise<Observation> {
    const url = storeListingUrl(pkg, this.cfg.locale, this.cfg.country);
    try {
      const res = await fetchWithRetry(
        url,
        {
          method: 'GET',
          headers: {
            'user-agent': `google-play-review-notify/${this.opts.version ?? '0.0.0'}`,
            'accept-language': this.cfg.locale,
          },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        },
        { retries: 1, fetchImpl: this.opts.fetchImpl ?? fetch },
      );
      const info = parseStoreListing(await res.text());
      if (info.updatedAt === undefined) {
        throw new Error('could not find the "Updated on" date in the listing HTML');
      }
      ctx.logger.debug(`Store listing ${pkg}: updated ${info.updatedText} (${info.updatedAt})`);
      const state: PackageState = { published: true, updatedAt: info.updatedAt, failures: 0 };
      if (info.updatedText) state.updatedText = info.updatedText;
      return { ok: true, state };
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        ctx.logger.debug(`Store listing ${pkg}: not published (404)`);
        return { ok: true, state: { published: false, failures: 0 } };
      }
      const failures = (before?.failures ?? 0) + 1;
      const msg = e instanceof Error ? e.message : String(e);
      if (failures === this.cfg.failureThreshold) {
        ctx.logger.error(
          `Store listing ${pkg} failed ${failures} times in a row; ` +
            `the page format may have changed (${msg})`,
        );
      } else {
        ctx.logger.warn(`Store listing ${pkg} fetch/parse failed (${failures}): ${msg}`);
      }
      return { ok: false, state: { ...(before ?? { published: false }), failures } };
    }
  }

  private liveEvent(ctx: PollContext, app: AppRef, observed: PackageState): ReviewEvent {
    const ev: ReviewEvent = {
      id: `store:${app.packageName}:${observed.updatedAt}:LIVE`,
      type: 'LIVE',
      packageName: app.packageName,
      track: 'production',
      source: 'store-listing',
      confidence: 'medium',
      observedAt: ctx.now.toISOString(),
      consoleUrl: consoleUrlFor(app.packageName),
    };
    if (app.name) ev.appName = app.name;
    return ev;
  }
}
