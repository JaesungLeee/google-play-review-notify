/**
 * Configuration schema and loader. See docs/PRD_ko.md §5.6.
 * Precedence (highest first): explicit overrides (Action inputs / CLI flags) > env > file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { REVIEW_EVENT_TYPES } from './types';

const eventTypeSchema = z.enum(REVIEW_EVENT_TYPES);

export const appConfigSchema = z.object({
  packageName: z.string().min(1),
  name: z.string().optional(),
  tracks: z.array(z.string()).default(['production']),
  channels: z.array(z.string()).optional(),
});

export const emailSourceSchema = z.object({
  enabled: z.boolean().default(false),
  auth: z
    .object({
      clientId: z.string(),
      clientSecret: z.string(),
      refreshToken: z.string(),
    })
    .optional(),
  lookbackHours: z.number().int().positive().default(24),
  senderAllowlist: z
    .array(z.string())
    .default(['googleplay-noreply@google.com', 'googleplay-developer-support@google.com']),
  /** 'builtin' or paths to rule files. */
  rules: z.union([z.literal('builtin'), z.array(z.string())]).default('builtin'),
  reasonMaxLength: z.number().int().positive().default(1000),
});

export const playApiSourceSchema = z.object({
  enabled: z.boolean().default(false),
  serviceAccountJson: z.string().optional(),
  emitLiveWithoutConfirmation: z.boolean().default(false),
});

export const storeListingSourceSchema = z.object({
  enabled: z.boolean().default(false),
  locale: z.string().default('en'),
  country: z.string().default('US'),
  failureThreshold: z.number().int().positive().default(5),
});

export const eventConfigSchema = z.object({
  enabled: z.boolean(),
  mentions: z.array(z.string()).default([]),
  mergeInto: eventTypeSchema.optional(),
});

const channelBase = { name: z.string().optional() };

export const channelSchema = z.discriminatedUnion('type', [
  z.object({ ...channelBase, type: z.literal('slack'), webhookUrl: z.string().url() }),
  z.object({ ...channelBase, type: z.literal('discord'), webhookUrl: z.string().url() }),
  z.object({
    ...channelBase,
    type: z.literal('webhook'),
    url: z.string().url(),
    secret: z.string().optional(),
    headers: z.record(z.string()).default({}),
    batch: z.boolean().default(false),
  }),
]);

export const stateStoreSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), path: z.string().default('.play-review-notify/state.json') }),
  z.object({
    type: z.literal('github-cache'),
    keyPrefix: z.string().default('play-review-notify-state'),
  }),
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('custom'), module: z.string() }),
]);

const DEFAULT_EVENTS: Record<
  (typeof REVIEW_EVENT_TYPES)[number],
  z.input<typeof eventConfigSchema>
> = {
  SUBMITTED: { enabled: false },
  APPROVED: { enabled: true },
  REJECTED: { enabled: true },
  LIVE: { enabled: true },
  POLICY_WARNING: { enabled: true },
  REMOVED: { enabled: true },
  SUSPENDED: { enabled: true },
  UNKNOWN_NOTICE: { enabled: false },
};

export const configSchema = z.object({
  version: z.literal(1).default(1),
  apps: z.array(appConfigSchema).min(1),
  sources: z
    .object({
      email: emailSourceSchema.default({}),
      playApi: playApiSourceSchema.default({}),
      storeListing: storeListingSourceSchema.default({}),
    })
    .default({}),
  events: z
    .record(eventTypeSchema, eventConfigSchema)
    .default({})
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
  channels: z.record(z.string(), channelSchema).default({}),
  defaultChannels: z.array(z.string()).default([]),
  templates: z.record(eventTypeSchema, z.string()).default({}),
  stateStore: stateStoreSchema.default({ type: 'file' }),
  includeReason: z.boolean().default(true),
  maxRetries: z.number().int().nonnegative().default(3),
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

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const interpolated = interpolateEnv(raw, env);
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

export function loadConfigFile(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read config file ${abs}: ${(e as Error).message}`);
  }
  const raw = abs.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  return parseConfig(raw, env);
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
