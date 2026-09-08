/** Email source adapter: primary signal. See docs/design.md, "What each signal can and cannot say". */
import type { Config } from '../../core/config';
import type {
  PollContext,
  PollResult,
  ReviewEvent,
  SourceAdapter,
  SourceState,
} from '../../core/types';
import { buildQuery, createGmailClient, type GmailClient } from './gmail';
import {
  classifyEmail,
  loadBuiltinRuleSets,
  loadRuleSetFiles,
  senderAllowed,
  type EmailRuleSet,
} from './rules';

interface EmailState extends SourceState {
  watermark?: string;
  processedMessageIds?: string[];
}

const MAX_PROCESSED_IDS = 500;

export class EmailSourceAdapter implements SourceAdapter {
  readonly name = 'email' as const;
  private readonly ruleSets: EmailRuleSet[];

  constructor(
    private readonly cfg: Config['sources']['email'],
    private readonly client: GmailClient,
    ruleSets?: EmailRuleSet[],
  ) {
    this.ruleSets =
      ruleSets ?? (cfg.rules === 'builtin' ? loadBuiltinRuleSets() : loadRuleSetFiles(cfg.rules));
  }

  static fromConfig(config: Config): EmailSourceAdapter {
    const cfg = config.sources.email;
    if (!cfg.auth)
      throw new Error('sources.email.auth is required when the email source is enabled');
    return new EmailSourceAdapter(cfg, createGmailClient(cfg.auth));
  }

  async poll(ctx: PollContext, prev: SourceState | undefined): Promise<PollResult> {
    const state = (prev ?? {}) as EmailState;
    const lookback = new Date(ctx.now.getTime() - this.cfg.lookbackHours * 3_600_000);
    const since = state.watermark && !ctx.baseline ? new Date(state.watermark) : lookback;
    // Overlap by 5 minutes to tolerate clock skew; dedupe handles repeats.
    const query = buildQuery(this.cfg.senderAllowlist, new Date(since.getTime() - 300_000));
    ctx.logger.debug(`Gmail query: ${query}`);

    const processed = new Set(state.processedMessageIds ?? []);
    const messages = await this.client.search(query);
    const events: ReviewEvent[] = [];
    let newest = since;

    for (const msg of messages) {
      const at = new Date(msg.receivedAt);
      if (at > newest) newest = at;
      if (processed.has(msg.id)) continue;
      processed.add(msg.id);
      if (!senderAllowed(msg.from, this.cfg.senderAllowlist)) continue;

      const c = classifyEmail(msg, this.ruleSets, { reasonMaxLength: this.cfg.reasonMaxLength });
      const packageName = c.packageName ?? this.matchByAppName(ctx, c.appName) ?? null;
      const ev: ReviewEvent = {
        id: `email:${msg.id}`,
        type: c.type,
        packageName,
        source: 'email',
        confidence: c.type === 'UNKNOWN_NOTICE' ? 'low' : 'high',
        observedAt: msg.receivedAt,
      };
      if (c.appName) ev.appName = c.appName;
      if (c.versionName) ev.versionName = c.versionName;
      if (c.versionCode) ev.versionCode = c.versionCode;
      if (c.reason) ev.reason = c.reason;
      if (packageName) ev.consoleUrl = consoleUrlFor(packageName);
      events.push(ev);
    }

    const nextState: EmailState = {
      watermark: newest.toISOString(),
      processedMessageIds: [...processed].slice(-MAX_PROCESSED_IDS),
    };
    return { events, nextState };
  }

  private matchByAppName(ctx: PollContext, appName: string | undefined): string | undefined {
    if (!appName) return undefined;
    const needle = appName.trim().toLowerCase();
    return ctx.apps.find((a) => a.name?.trim().toLowerCase() === needle)?.packageName;
  }
}

export function consoleUrlFor(packageName: string): string {
  // Play Console deep links require the developer id; the search URL works without it.
  return `https://play.google.com/console/developers/app-list?search=${encodeURIComponent(packageName)}`;
}
