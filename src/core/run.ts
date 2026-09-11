/**
 * Single pipeline entry used by both the CLI and the GitHub Action. See docs/design.md, "Pipeline".
 *
 *   sources.poll → normalize → dedupe/diff (state) → route + render → notify → save state
 */
import type { Config } from './config';
import { applyMerge, logicalKey, resolveChannels } from './router';
import { createEmptyState, pruneEvents } from './state';
import type {
  DeliveryResult,
  EventRecord,
  Logger,
  Notifier,
  RenderedMessage,
  ReviewEvent,
  RunSummary,
  SourceAdapter,
  State,
  StateStore,
} from './types';
import { renderMessage } from '../templates';

export interface RunOptions {
  config: Config;
  sources: SourceAdapter[];
  notifiers: Map<string, Notifier>;
  stateStore: StateStore;
  logger: Logger;
  dryRun?: boolean;
  now?: Date;
}

export async function runOnce(opts: RunOptions): Promise<RunSummary> {
  const { config, logger } = opts;
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;

  const loaded = await opts.stateStore.load();
  const baseline = loaded === null;
  // Work on a copy so a store that hands back a live object is never mutated on dry-run/failure.
  const state: State = loaded ? structuredClone(loaded) : createEmptyState(now);
  if (baseline) logger.info('No prior state found: recording a baseline, notifications suppressed');

  const summary: RunSummary = {
    baseline,
    dryRun,
    polled: [],
    events: [],
    deliveries: [],
    hasRejection: false,
  };

  // 1. Poll every source; one failure never blocks the others.
  const collected: ReviewEvent[] = [];
  for (const source of opts.sources) {
    try {
      const result = await source.poll(
        { logger, now, baseline, apps: config.apps },
        state.sources[source.name],
      );
      state.sources[source.name] = result.nextState;
      collected.push(...result.events);
      summary.polled.push({ source: source.name, ok: true, events: result.events.length });
      logger.debug(`Source ${source.name} produced ${result.events.length} event(s)`);
    } catch (e) {
      const error = (e as Error).message;
      summary.polled.push({ source: source.name, ok: false, events: 0, error });
      logger.error(`Source ${source.name} failed: ${error}`);
    }
  }

  // 2. Dedupe against state, apply merges and per-event enablement.
  //    Two sources may report the same fact under different ids (the API and the rejection
  //    email); the logical key `pkg:versionCode:type` catches that across sources and for
  //    merged types. A repeat that adds a reason the first notification lacked becomes a
  //    follow-up; anything else is suppressed. Repeats from the same source (two emails about
  //    one version) are delivered as before: the id is the dedupe key there.
  const recorded = new Map<string, { id: string; record: EventRecord }>();
  for (const [id, record] of Object.entries(state.events)) {
    const lk = logicalKeyOf(record);
    if (lk) recorded.set(lk, { id, record });
  }
  const inRun = new Map<string, ReviewEvent>();
  const fresh: ReviewEvent[] = [];
  for (const raw of collected) {
    if (state.events[raw.id]) continue;
    const event = applyMerge(config, raw);
    const eventConfig = config.events[raw.type];
    if (!eventConfig?.enabled) {
      logger.debug(`Event ${raw.id} (${raw.type}) disabled by config`);
      continue;
    }
    const lk = logicalKey(event);
    const merged = event.type !== raw.type;
    const sibling = lk ? inRun.get(lk) : undefined;
    if (sibling && (merged || sourceOf(sibling.id) !== sourceOf(raw.id))) {
      // Same fact twice in one run: keep one notification, with the details of both.
      if (event.reason && !sibling.reason) sibling.reason = event.reason;
      if (event.versionName && !sibling.versionName) sibling.versionName = event.versionName;
      logger.debug(`Event ${raw.id} merged into ${sibling.id} (same ${lk})`);
      state.events[raw.id] = toRecord(event, now, { delivered: true, suppressed: true });
      continue;
    }
    const prior = lk ? recorded.get(lk) : undefined;
    if (prior && (merged || sourceOf(prior.id) !== sourceOf(raw.id))) {
      const followUp =
        Boolean(event.reason) && !prior.record.hasReason && eventConfig.reasonFollowUp;
      if (!followUp) {
        logger.debug(`Event ${raw.id} repeats already-recorded ${lk}, suppressed`);
        state.events[raw.id] = toRecord(event, now, { delivered: true, suppressed: true });
        continue;
      }
      prior.record.hasReason = true;
      logger.debug(`Event ${raw.id} adds a reason to already-recorded ${lk}, sent as follow-up`);
      event.followUp = true;
    }
    if (lk) inRun.set(lk, event);
    fresh.push(event);
  }
  summary.events = fresh;
  summary.hasRejection = fresh.some((e) => e.type === 'REJECTED');

  // 3. Baseline run: record only.
  if (baseline) {
    for (const e of fresh)
      state.events[e.id] = toRecord(e, now, { delivered: true, suppressed: true });
    await persist(opts, state, now);
    return summary;
  }

  // 4. Deliver new events plus retries of previously failed ones.
  const retries = Object.entries(state.events)
    .filter(([, r]) => !r.delivered && r.attempts < config.maxRetries && r.pendingChannels?.length)
    .map(([id, r]) => ({ id, record: r }));

  const pending: PendingDelivery[] = [];
  for (const event of fresh) {
    const channels = resolveChannels(config, event);
    state.events[event.id] = toRecord(event, now, { delivered: false, pendingChannels: channels });
    pending.push(toPending(config, event, channels));
  }
  for (const { id, record } of retries) {
    logger.info(`Retrying delivery of ${id} (attempt ${record.attempts + 1}/${config.maxRetries})`);
    pending.push(toPending(config, fromRecord(id, record), record.pendingChannels ?? []));
  }
  await deliverAll(opts, state, pending, summary.deliveries, now);

  await persist(opts, state, now);
  return summary;
}

interface PendingDelivery {
  event: ReviewEvent;
  message: RenderedMessage;
  channels: string[];
  failed: string[];
}

function toPending(config: Config, event: ReviewEvent, channels: string[]): PendingDelivery {
  const app = config.apps.find((a) => a.packageName === event.packageName);
  return { event, message: renderMessage(config, event, app), channels, failed: [] };
}

/**
 * Deliver channel by channel so that channels with `batch: true` receive all of a run's events
 * in one request. Each event's record is updated once at the end, whichever path it took.
 */
async function deliverAll(
  opts: RunOptions,
  state: State,
  items: PendingDelivery[],
  deliveries: DeliveryResult[],
  now: Date,
): Promise<void> {
  const { config, logger } = opts;
  const byChannel = new Map<string, PendingDelivery[]>();
  for (const item of items) {
    for (const name of item.channels) {
      const group = byChannel.get(name) ?? [];
      group.push(item);
      byChannel.set(name, group);
    }
  }

  for (const [name, group] of byChannel) {
    const channel = config.channels[name];
    if (!channel) {
      logger.warn(`Channel "${name}" not configured, skipping`);
      continue;
    }
    const notifier = opts.notifiers.get(channel.type);
    if (!notifier) {
      logger.warn(`No notifier registered for channel type "${channel.type}"`);
      for (const item of group) item.failed.push(name);
      continue;
    }
    if (opts.dryRun) {
      for (const item of group) {
        logger.info(
          `[dry-run] ${channel.type}:${name} ← ${item.message.title}\n${item.message.body}`,
        );
        deliveries.push({ eventId: item.event.id, channel: name, ok: true });
      }
      continue;
    }
    const target = { ...channel, name };
    const batch = 'batch' in channel && channel.batch && notifier.sendBatch;
    if (batch) {
      try {
        await notifier.sendBatch!(
          group.map((g) => g.message),
          target,
        );
        for (const item of group)
          deliveries.push({ eventId: item.event.id, channel: name, ok: true });
        logger.info(`Delivered ${group.length} event(s) to ${name} in one batch`);
      } catch (e) {
        const error = (e as Error).message;
        for (const item of group) markFailed(state, item, name, error, deliveries);
        logger.error(`Batch delivery to ${name} failed: ${error}`);
      }
      continue;
    }
    for (const item of group) {
      try {
        await notifier.send(item.message, target);
        deliveries.push({ eventId: item.event.id, channel: name, ok: true });
        logger.info(
          `Delivered ${item.event.type} for ${item.event.packageName ?? '<unknown>'} to ${name}`,
        );
      } catch (e) {
        const error = (e as Error).message;
        markFailed(state, item, name, error, deliveries);
        logger.error(`Delivery to ${name} failed: ${error}`);
      }
    }
  }

  for (const item of items) {
    const record = state.events[item.event.id];
    if (!record) continue;
    record.attempts += 1;
    record.delivered = item.failed.length === 0;
    if (record.delivered) delete record.pendingChannels;
    else record.pendingChannels = item.failed;
    record.at = record.at || now.toISOString();
  }
}

function markFailed(
  state: State,
  item: PendingDelivery,
  channel: string,
  error: string,
  deliveries: DeliveryResult[],
): void {
  deliveries.push({ eventId: item.event.id, channel, ok: false, error });
  item.failed.push(channel);
  const record = state.events[item.event.id];
  if (record) record.lastError = error;
}

async function persist(opts: RunOptions, state: State, now: Date): Promise<void> {
  const pruned = pruneEvents({ ...state, updatedAt: now.toISOString() }, now);
  if (opts.dryRun) {
    opts.logger.info('[dry-run] state not saved');
    return;
  }
  await opts.stateStore.save(pruned);
}

function toRecord(e: ReviewEvent, now: Date, extra: Partial<EventRecord>): EventRecord {
  const rec: EventRecord = {
    type: e.type,
    packageName: e.packageName,
    at: e.observedAt || now.toISOString(),
    delivered: false,
    attempts: 0,
    ...extra,
  };
  if (e.versionCode !== undefined) rec.versionCode = e.versionCode;
  if (e.reason) rec.hasReason = true;
  return rec;
}

function logicalKeyOf(r: EventRecord): string | null {
  return r.packageName && r.versionCode ? `${r.packageName}:${r.versionCode}:${r.type}` : null;
}

/** Source family from the id prefix; `emit` deliberately shares the Play API's `api:` ids. */
function sourceOf(id: string): string {
  return id.split(':')[0] ?? '';
}

/** Reconstruct the minimum needed to re-render a message for retry. */
function fromRecord(id: string, r: EventRecord): ReviewEvent {
  const prefix = id.split(':')[0] ?? 'manual';
  const source: ReviewEvent['source'] =
    prefix === 'email' ? 'email' : prefix === 'api' ? 'play-api' : 'manual';
  const ev: ReviewEvent = {
    id,
    type: r.type,
    packageName: r.packageName,
    source,
    confidence: 'medium',
    observedAt: r.at,
  };
  if (r.versionCode !== undefined) ev.versionCode = r.versionCode;
  return ev;
}
