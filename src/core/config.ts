/**
 * Configuration schema and loader. See README.md, "Configuration".
 * Precedence (highest first): explicit overrides (Action inputs / CLI flags) > env > file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { LEGACY_EVENT_TYPES, REVIEW_EVENT_TYPES } from './types';

const eventTypeSchema = z.enum(REVIEW_EVENT_TYPES);

export const appConfigSchema = z
  .object({
    packageName: z.string().min(1).describe('Android application id, e.g. com.example.app.'),
    name: z
      .string()
      .optional()
      .describe(
        'Display name as shown in Play Console. Used to match emails that omit the package name.',
      ),
    tracks: z
      .array(z.string())
      .default(['production'])
      .describe('Tracks watched by the Play API source (production, beta, alpha, internal, ...).'),
    channels: z
      .array(z.string())
      .optional()
      .describe('Channel names for this app. Falls back to defaultChannels when omitted.'),
  })
  .describe('One app to watch.');

export const emailSourceSchema = z
  .object({
    enabled: z.boolean().default(false),
    auth: z
      .object({
        clientId: z.string().describe('OAuth client id (${GMAIL_CLIENT_ID}).'),
        clientSecret: z.string().describe('OAuth client secret (${GMAIL_CLIENT_SECRET}).'),
        refreshToken: z
          .string()
          .describe('Refresh token with the gmail.readonly scope (${GMAIL_REFRESH_TOKEN}).'),
      })
      .optional()
      .describe('Gmail OAuth credentials. See docs/gmail-oauth.md. Required when enabled.'),
    lookbackHours: z
      .number()
      .int()
      .positive()
      .default(24)
      .describe('Search window used on the first run and after state loss.'),
    senderAllowlist: z
      .array(z.string())
      .default([
        // Policy / review outcome notices ("Google Play Support"), observed in Phase 0.
        'no-reply-googleplay-developer@google.com',
        // General Play Console announcements ("Google Play").
        'googleplay-noreply@google.com',
        'googleplay-developer-support@google.com',
      ])
      .describe('Sender addresses that count as Google Play. The default covers the known ones.'),
    rules: z
      .union([z.literal('builtin'), z.array(z.string())])
      .default('builtin')
      .describe(
        "'builtin' for the bundled English and Korean rule sets, or paths to rule JSON files.",
      ),
    reasonMaxLength: z
      .number()
      .int()
      .positive()
      .default(1000)
      .describe('Maximum length of the extracted rejection reason.'),
  })
  .describe(
    'Gmail source: POLICY_WARNING, plus the reason text for REJECTED, from Play Console emails.',
  );

export const playApiSourceSchema = z
  .object({
    enabled: z.boolean().default(false),
    serviceAccountJson: z
      .string()
      .optional()
      .describe(
        'Service account key: the JSON content (${PLAY_SERVICE_ACCOUNT_JSON}) or a file path.',
      ),
  })
  .describe(
    'Play Developer API source: PENDING_SUBMISSION, SUBMITTED, APPROVED, REJECTED and LIVE from the release lifecycle of each configured track.',
  );

export const eventConfigSchema = z
  .object({
    enabled: z.boolean().describe('Whether this event type is notified.'),
    mentions: z
      .array(z.string())
      .default([])
      .describe("Mentions prepended to the message, e.g. '<!channel>' or '<@U123>'."),
    mergeInto: eventTypeSchema
      .optional()
      .describe('Report this event under another type, e.g. LIVE as APPROVED.'),
    reasonFollowUp: z
      .boolean()
      .default(true)
      .describe(
        'Send a follow-up when a later source adds a reason to an already-notified event (the rejection email arriving after the API reported REJECTED).',
      ),
  })
  .describe('Per-event-type settings.');

const channelBase = { name: z.string().optional().describe('Human-readable label for logs.') };

export const channelSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        ...channelBase,
        type: z.literal('slack'),
        webhookUrl: z.string().url().describe('Slack Incoming Webhook URL (${SLACK_WEBHOOK_URL}).'),
      })
      .describe('Slack Incoming Webhook (Block Kit message).'),
    z
      .object({
        ...channelBase,
        type: z.literal('discord'),
        webhookUrl: z.string().url().describe('Discord webhook URL (${DISCORD_WEBHOOK_URL}).'),
      })
      .describe('Discord webhook (embed message).'),
    z
      .object({
        ...channelBase,
        type: z.literal('webhook'),
        url: z.string().url().describe('HTTP endpoint that receives the JSON payload.'),
        secret: z
          .string()
          .optional()
          .describe('HMAC-SHA256 key for the X-Play-Review-Signature header.'),
        headers: z.record(z.string()).default({}).describe('Extra request headers.'),
        batch: z
          .boolean()
          .default(false)
          .describe('Send one array of events per run instead of one request per event.'),
      })
      .describe('Generic webhook: n8n, Make, Zapier, or your own server.'),
  ])
  .describe('A notification target.');

export const stateStoreSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('file'),
        path: z.string().default('.play-review-notify/state.json'),
      })
      .describe('JSON file on disk (CLI default).'),
    z
      .object({
        type: z.literal('github-cache'),
        keyPrefix: z.string().default('play-review-notify-state'),
      })
      .describe('GitHub Actions cache (Action default). Entries expire after 7 days unused.'),
    z.object({ type: z.literal('none') }).describe('No persistence; relies on lookbackHours only.'),
    z
      .object({
        type: z.literal('custom'),
        module: z.string().describe('Path to a local module exporting a StateStore.'),
      })
      .describe('Custom store loaded from a local module.'),
  ])
  .describe('Where the event ledger and per-source cursors are kept between runs.');

const DEFAULT_EVENTS: Record<
  (typeof REVIEW_EVENT_TYPES)[number],
  z.input<typeof eventConfigSchema>
> = {
  PENDING_SUBMISSION: { enabled: false },
  SUBMITTED: { enabled: false },
  APPROVED: { enabled: true },
  REJECTED: { enabled: true },
  LIVE: { enabled: true },
  POLICY_WARNING: { enabled: true },
};

/**
 * Keys accepted from configs written for earlier versions and silently dropped, so an upgrade
 * never breaks a working config. `parseConfig` reports them through `onWarning`.
 */
const LEGACY_SOURCE_KEYS = ['storeListing'] as const;
const LEGACY_PLAY_API_KEYS = ['emitLiveWithoutConfirmation'] as const;

function stripLegacy(raw: unknown, warn: (msg: string) => void): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  const events = obj['events'];
  if (events && typeof events === 'object' && !Array.isArray(events)) {
    const copy = { ...(events as Record<string, unknown>) };
    for (const t of LEGACY_EVENT_TYPES) {
      if (t in copy) {
        warn(`events.${t} is no longer supported and was ignored (removed in 0.4)`);
        delete copy[t];
      }
    }
    obj['events'] = copy;
  }
  const sources = obj['sources'];
  if (sources && typeof sources === 'object' && !Array.isArray(sources)) {
    const copy = { ...(sources as Record<string, unknown>) };
    for (const k of LEGACY_SOURCE_KEYS) {
      if (k in copy) {
        warn(`sources.${k} is no longer supported and was ignored (removed in 0.4)`);
        delete copy[k];
      }
    }
    const playApi = copy['playApi'];
    if (playApi && typeof playApi === 'object' && !Array.isArray(playApi)) {
      const p = { ...(playApi as Record<string, unknown>) };
      for (const k of LEGACY_PLAY_API_KEYS) {
        if (k in p) {
          warn(`sources.playApi.${k} is no longer supported and was ignored (removed in 0.4)`);
          delete p[k];
        }
      }
      copy['playApi'] = p;
    }
    obj['sources'] = copy;
  }
  return obj;
}

export const configSchema = z.object({
  version: z.literal(1).default(1).describe('Config format version.'),
  apps: z.array(appConfigSchema).min(1).describe('Apps to watch.'),
  sources: z
    .object({
      email: emailSourceSchema.default({}),
      playApi: playApiSourceSchema.default({}),
    })
    .default({})
    .describe('Signal sources. Enable at least one.'),
  events: z
    .record(eventTypeSchema, eventConfigSchema)
    .default({})
    .describe(
      'Per-event-type overrides. Defaults: everything on except PENDING_SUBMISSION and SUBMITTED.',
    )
    .transform((given) => {
      const merged: Record<string, z.output<typeof eventConfigSchema>> = {};
      for (const t of REVIEW_EVENT_TYPES) {
        merged[t] = eventConfigSchema.parse({ ...DEFAULT_EVENTS[t], ...(given[t] ?? {}) });
      }
      return merged as Record<
        (typeof REVIEW_EVENT_TYPES)[number],
        z.output<typeof eventConfigSchema>
      >;
    }),
  channels: z
    .record(z.string(), channelSchema)
    .default({})
    .describe('Named notification targets referenced from apps[].channels and defaultChannels.'),
  defaultChannels: z
    .array(z.string())
    .default([])
    .describe('Channels used by apps that do not list their own.'),
  templates: z
    .record(eventTypeSchema, z.string())
    .default({})
    .describe('Mustache-style message overrides per event type ({{appName}}, {{reason}}, ...).'),
  stateStore: stateStoreSchema.default({ type: 'file' }),
  includeReason: z
    .boolean()
    .default(true)
    .describe('Include the extracted rejection reason in notifications.'),
  maxRetries: z
    .number()
    .int()
    .nonnegative()
    .default(3)
    .describe('Retries per notification delivery.'),
});

export type Config = z.output<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;
export type AppConfig = z.output<typeof appConfigSchema>;
export type ChannelConfig = z.output<typeof channelSchema>;
export type EventConfig = z.output<typeof eventConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const ENV_REF = /\$\{([A-Z0-9_]+)\}/g;

/** Replace `${ENV}` references in every string value. Missing variables are a hard error. */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (_m, name: string) => {
      const v = env[name];
      if (v === undefined) throw new ConfigError(`Environment variable ${name} is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v, env)]),
    );
  }
  return value;
}

export interface ParseOptions {
  /** Receives one message per ignored legacy key. Default: silent. */
  onWarning?: (message: string) => void;
}

export function parseConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  opts: ParseOptions = {},
): Config {
  const interpolated = interpolateEnv(stripLegacy(raw, opts.onWarning ?? (() => undefined)), env);
  const result = configSchema.safeParse(interpolated);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }
  return validateReferences(result.data);
}

function validateReferences(config: Config): Config {
  const known = new Set(Object.keys(config.channels));
  const check = (names: string[], where: string) => {
    for (const n of names) {
      if (!known.has(n)) throw new ConfigError(`${where} references unknown channel "${n}"`);
    }
  };
  check(config.defaultChannels, 'defaultChannels');
  for (const app of config.apps) check(app.channels ?? [], `apps[${app.packageName}].channels`);
  return config;
}

export function loadConfigFile(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: ParseOptions = {},
): Config {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read config file ${abs}: ${(e as Error).message}`);
  }
  const raw = abs.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  return parseConfig(raw, env, opts);
}

/** Collect secret-like values so loggers can redact them. */
export function collectSecrets(config: Config): string[] {
  const out: string[] = [];
  const email = config.sources.email.auth;
  if (email) out.push(email.clientSecret, email.refreshToken);
  if (config.sources.playApi.serviceAccountJson)
    out.push(config.sources.playApi.serviceAccountJson);
  for (const ch of Object.values(config.channels)) {
    if (ch.type === 'webhook') {
      out.push(ch.url);
      if (ch.secret) out.push(ch.secret);
    } else out.push(ch.webhookUrl);
  }
  return out.filter((s) => s.length >= 8);
}
