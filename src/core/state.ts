import type { State } from './types';
import { STATE_SCHEMA_VERSION } from './types';

export const MAX_EVENT_RECORDS = 500;
export const MAX_EVENT_AGE_DAYS = 30;

export function createEmptyState(now: Date = new Date()): State {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    sources: {},
    events: {},
  };
}

/** Upgrade older on-disk shapes. Unknown/corrupt input yields null so the run baselines. */
export function migrateState(raw: unknown): State | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<State> & { schemaVersion?: number };
  if (obj.schemaVersion !== STATE_SCHEMA_VERSION) return null;
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date(0).toISOString(),
    sources: obj.sources && typeof obj.sources === 'object' ? obj.sources : {},
    events: obj.events && typeof obj.events === 'object' ? obj.events : {},
  };
}

/** Drop old delivered records so the state document stays bounded. */
export function pruneEvents(state: State, now: Date = new Date()): State {
  const cutoff = now.getTime() - MAX_EVENT_AGE_DAYS * 86_400_000;
  const entries = Object.entries(state.events)
    .filter(([, r]) => !r.delivered || new Date(r.at).getTime() >= cutoff)
    .sort(([, a], [, b]) => b.at.localeCompare(a.at))
    .slice(0, MAX_EVENT_RECORDS);
  return { ...state, events: Object.fromEntries(entries) };
}
