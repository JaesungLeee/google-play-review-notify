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
  const seenLogical = new Set(
    Object.entries(state.events)
      .map(([, r]) =>
        r.packageName && r.versionCode ? `${r.packageName}:${r.versionCode}:${r.type}` : null,
      )
      .filter((k): k is string => k !== null),
  );
  const fresh: ReviewEvent[] = [];
  for (const raw of collected) {
    if (state.events[raw.id]) continue;
    const event = applyMerge(config, raw);
    if (!config.events[raw.type]?.enabled) {
      logger.debug(`Event ${raw.id} (${raw.type}) disabled by config`);
      continue;
    }
    const lk = logicalKey(event);
    if (lk && seenLogical.has(lk) && event.type !== raw.type) {
      logger.debug(`Event ${raw.id} merged into already-recorded ${lk}, suppressed`);
      state.events[raw.id] = toRecord(event, now, { delivered: true, suppressed: true });
      continue;
    }
    if (lk) seenLogical.add(lk);
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

  for (const event of fresh) {
    const channels = resolveChannels(config, event);
    state.events[event.id] = toRecord(event, now, { delivered: false, pendingChannels: channels });
    await deliver(opts, state, event, channels, summary.deliveries, now);
  }
  for (const { id, record } of retries) {
    const event = fromRecord(id, record);
    logger.info(`Retrying delivery of ${id} (attempt ${record.attempts + 1}/${config.maxRetries})`);
    await deliver(opts, state, event, record.pendingChannels ?? [], summary.deliveries, now);
  }

  await persist(opts, state, now);
  return summary;
}

async function deliver(
  opts: RunOptions,
  state: State,
  event: ReviewEvent,
  channels: string[],
  deliveries: DeliveryResult[],
  now: Date,
): Promise<void> {
  const { config, logger } = opts;
  const record = state.events[event.id];
  if (!record) return;
  const app = config.apps.find((a) => a.packageName === event.packageName);
  const message = renderMessage(config, event, app);
  const stillPending: string[] = [];

  for (const name of channels) {
    const channel = config.channels[name];
    if (!channel) {
      logger.warn(`Channel "${name}" not configured, skipping`);
      continue;
    }
    const notifier = opts.notifiers.get(channel.type);
    if (!notifier) {
      logger.warn(`No notifier registered for channel type "${channel.type}"`);
      stillPending.push(name);
      continue;
    }
    if (opts.dryRun) {
      logger.info(`[dry-run] ${channel.type}:${name} ← ${message.title}\n${message.body}`);
      deliveries.push({ eventId: event.id, channel: name, ok: true });
      continue;
    }
    try {
      await notifier.send(message, { ...channel, name });
      deliveries.push({ eventId: event.id, channel: name, ok: true });
      logger.info(`Delivered ${event.type} for ${event.packageName ?? '<unknown>'} to ${name}`);
    } catch (e) {
      const error = (e as Error).message;
      deliveries.push({ eventId: event.id, channel: name, ok: false, error });
      record.lastError = error;
      stillPending.push(name);
      logger.error(`Delivery to ${name} failed: ${error}`);
    }
  }

  record.attempts += 1;
  record.delivered = stillPending.length === 0;
  if (record.delivered) delete record.pendingChannels;
  else record.pendingChannels = stillPending;
  record.at = record.at || now.toISOString();
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
  return rec;
}

/** Reconstruct the minimum needed to re-render a message for retry. */
function fromRecord(id: string, r: EventRecord): ReviewEvent {
  const prefix = id.split(':')[0] ?? 'manual';
  const source: ReviewEvent['source'] =
    prefix === 'email'
      ? 'email'
      : prefix === 'api'
        ? 'play-api'
        : prefix === 'store'
          ? 'store-listing'
          : 'manual';
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
