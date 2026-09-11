/**
 * Core domain types. See docs/design.md (event model, plugin interfaces).
 */

export const REVIEW_EVENT_TYPES = [
  'PENDING_SUBMISSION',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'LIVE',
  'POLICY_WARNING',
] as const;

export type ReviewEventType = (typeof REVIEW_EVENT_TYPES)[number];

/** Types that existed before 0.4 and are accepted (with a warning) in old configs, then dropped. */
export const LEGACY_EVENT_TYPES = ['REMOVED', 'SUSPENDED', 'UNKNOWN_NOTICE'] as const;

export type EventSource = 'email' | 'play-api' | 'manual';
export type Confidence = 'high' | 'medium' | 'low';

export interface ReviewEvent {
  /** Dedupe key, e.g. "email:<gmailMessageId>" or "api:<pkg>:<track>:<versionCode>:LIVE". */
  id: string;
  type: ReviewEventType;
  /** null when the source could not identify the package (e.g. an email without it). */
  packageName: string | null;
  appName?: string;
  track?: string;
  versionCode?: string;
  versionName?: string;
  /** Rejection / warning reason, plain text, already length-capped by the source. */
  reason?: string;
  consoleUrl?: string;
  source: EventSource;
  confidence: Confidence;
  /** ISO 8601 */
  observedAt: string;
  /**
   * True when this repeats an already-notified event because a later source added details
   * (a rejection email delivering the reason after the API reported the rejection).
   */
  followUp?: boolean;
  /** Debug only. Never persisted or sent. */
  raw?: unknown;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Opaque per-source state persisted between runs (watermarks, observed version codes, ...). */
export type SourceState = Record<string, unknown>;

export interface PollContext {
  logger: Logger;
  now: Date;
  /** True when no prior state exists (first run or state loss): sources should only baseline. */
  baseline: boolean;
  apps: AppRef[];
}

export interface AppRef {
  packageName: string;
  name?: string | undefined;
  tracks: string[];
}

export interface PollResult {
  events: ReviewEvent[];
  nextState: SourceState;
}

export interface SourceAdapter {
  readonly name: EventSource;
  poll(ctx: PollContext, state: SourceState | undefined): Promise<PollResult>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const STATE_SCHEMA_VERSION = 1 as const;

export interface EventRecord {
  type: ReviewEventType;
  packageName: string | null;
  versionCode?: string;
  at: string;
  delivered: boolean;
  /** True when the event was recorded during a baseline run and intentionally not sent. */
  suppressed?: boolean;
  /** True when the notified event carried a reason; a later reason then needs no follow-up. */
  hasReason?: boolean;
  attempts: number;
  lastError?: string;
  /** Channels that still need delivery (only when delivered === false). */
  pendingChannels?: string[];
}

export interface State {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  updatedAt: string;
  sources: Record<string, SourceState>;
  events: Record<string, EventRecord>;
}

export interface StateStore {
  readonly name: string;
  load(): Promise<State | null>;
  save(state: State): Promise<void>;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface RenderedMessage {
  event: ReviewEvent;
  /** Config entry for the event's app, when the package is configured. */
  app?: AppRef;
  title: string;
  body: string;
  /** Hex color without '#', e.g. "d73a49". */
  color: string;
  mentions: string[];
  fields: Array<{ label: string; value: string }>;
}

export interface Notifier {
  readonly type: string;
  send(message: RenderedMessage, channel: ChannelTarget): Promise<void>;
  /**
   * Deliver several messages in one request. Used instead of `send` when the channel has
   * `batch: true`; the whole batch succeeds or fails together.
   */
  sendBatch?(messages: RenderedMessage[], channel: ChannelTarget): Promise<void>;
}

/** Resolved channel configuration handed to a Notifier. */
export interface ChannelTarget {
  name: string;
  type: string;
  [key: string]: unknown;
}

export interface DeliveryResult {
  eventId: string;
  channel: string;
  ok: boolean;
  error?: string;
}

export interface RunSummary {
  baseline: boolean;
  dryRun: boolean;
  polled: Array<{ source: EventSource; ok: boolean; events: number; error?: string }>;
  events: ReviewEvent[];
  deliveries: DeliveryResult[];
  hasRejection: boolean;
}
