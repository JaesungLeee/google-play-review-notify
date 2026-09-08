import type { Config } from './config';
import type { ReviewEvent } from './types';

/** Channel names an event should be delivered to. Empty list means "nowhere" (not an error). */
export function resolveChannels(config: Config, event: ReviewEvent): string[] {
  const app = event.packageName
    ? config.apps.find((a) => a.packageName === event.packageName)
    : undefined;
  const names = app?.channels ?? config.defaultChannels;
  return [...new Set(names)];
}

/** Apply `mergeInto`: the event is rendered and deduped as the target type. */
export function applyMerge(config: Config, event: ReviewEvent): ReviewEvent {
  const target = config.events[event.type]?.mergeInto;
  if (!target || target === event.type) return event;
  return { ...event, type: target };
}

/** Logical key used to suppress a merged event when its target was already recorded. */
export function logicalKey(event: ReviewEvent): string | null {
  if (!event.packageName || !event.versionCode) return null;
  return `${event.packageName}:${event.versionCode}:${event.type}`;
}
