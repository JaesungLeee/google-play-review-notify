/** GitHub Action entry. Inputs > env > config file (docs/design.md, "Configuration precedence"). */
import { PACKAGE_VERSION } from '../core/version';
import * as core from '@actions/core';
import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import { collectSecrets, parseConfig, type ConfigInput } from '../core/config';
import { runOnce } from '../core/run';
import type { Logger, ReviewEvent } from '../core/types';
import { createDefaultNotifiers } from '../notifiers';
import { createSources, ManualSourceAdapter, manualEventId } from '../sources';
import { createStateStore } from '../state';

const VERSION = PACKAGE_VERSION;

function actionLogger(secrets: string[]): Logger {
  for (const s of secrets) core.setSecret(s);
  return {
    debug: (m, meta) => core.debug(fmt(m, meta)),
    info: (m, meta) => core.info(fmt(m, meta)),
    warn: (m, meta) => core.warning(fmt(m, meta)),
    error: (m, meta) => core.error(fmt(m, meta)),
  };
}
const fmt = (m: string, meta?: Record<string, unknown>) =>
  meta && Object.keys(meta).length ? `${m} ${JSON.stringify(meta)}` : m;

function input(name: string): string | undefined {
  const v = core.getInput(name);
  return v === '' ? undefined : v;
}

/** Build a config object from Action inputs, layered over the optional config file. */
export function buildConfigInput(): ConfigInput {
  const path = input('config-path') ?? 'play-review-notify.yml';
  const base: Record<string, unknown> = existsSync(path)
    ? ((parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>) ?? {})
    : {};

  const cfg = base as unknown as ConfigInput & Record<string, unknown>;
  cfg.sources = (cfg.sources ?? {}) as ConfigInput['sources'];
  cfg.channels = (cfg.channels ?? {}) as ConfigInput['channels'];

  const packages = input('packages');
  if (packages) {
    cfg.apps = packages
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((packageName) => ({ packageName }));
  }

  const gmailId = input('gmail-client-id');
  const gmailSecret = input('gmail-client-secret');
  const gmailToken = input('gmail-refresh-token');
  if (gmailId && gmailSecret && gmailToken) {
    cfg.sources!.email = {
      ...(cfg.sources!.email ?? {}),
      enabled: true,
      auth: { clientId: gmailId, clientSecret: gmailSecret, refreshToken: gmailToken },
    };
  }
  const sa = input('play-service-account-json');
  if (sa)
    cfg.sources!.playApi = {
      ...(cfg.sources!.playApi ?? {}),
      enabled: true,
      serviceAccountJson: sa,
    };

  const slack = input('slack-webhook-url');
  const discord = input('discord-webhook-url');
  const webhook = input('webhook-url');
  const added: string[] = [];
  if (slack) {
    cfg.channels!['slack'] = { type: 'slack', webhookUrl: slack };
    added.push('slack');
  }
  if (discord) {
    cfg.channels!['discord'] = { type: 'discord', webhookUrl: discord };
    added.push('discord');
  }
  if (webhook) {
    const secret = input('webhook-secret');
    cfg.channels!['webhook'] = { type: 'webhook', url: webhook, ...(secret ? { secret } : {}) };
    added.push('webhook');
  }
  if (added.length && !(cfg.defaultChannels && cfg.defaultChannels.length))
    cfg.defaultChannels = added;

  const store = input('state-store') ?? (cfg.stateStore ? undefined : 'github-cache');
  if (store === 'github-cache') cfg.stateStore = { type: 'github-cache' };
  else if (store === 'file') cfg.stateStore = { type: 'file' };
  else if (store === 'none') cfg.stateStore = { type: 'none' };

  return cfg;
}

async function main(): Promise<void> {
  const config = parseConfig(buildConfigInput());
  const log = actionLogger(collectSecrets(config));
  const dryRun = core.getBooleanInput('dry-run');

  const sources = createSources(config, log, { version: VERSION });
  const emit = input('emit-event');
  if (emit) {
    const parsed = JSON.parse(emit) as Partial<ReviewEvent> & {
      type: ReviewEvent['type'];
      packageName: string;
    };
    const event: ReviewEvent = {
      ...parsed,
      id: manualEventId(parsed),
      packageName: parsed.packageName,
      source: 'manual',
      confidence: 'high',
      observedAt: parsed.observedAt ?? new Date().toISOString(),
    };
    sources.push(new ManualSourceAdapter([event]));
  }

  const summary = await runOnce({
    config,
    sources,
    notifiers: createDefaultNotifiers({
      version: VERSION,
      runId: `gha:${process.env['GITHUB_RUN_ID'] ?? 'unknown'}`,
    }),
    stateStore: await createStateStore(config, log),
    logger: log,
    dryRun,
  });

  core.setOutput('events', JSON.stringify(summary.events));
  core.setOutput('events-count', String(summary.events.length));
  core.setOutput('has-rejection', String(summary.hasRejection));

  await core.summary
    .addHeading('Google Play review notify', 3)
    .addRaw(
      summary.baseline ? '_Baseline run: state initialized, notifications suppressed._\n' : '',
    )
    .addTable([
      [
        { data: 'Type', header: true },
        { data: 'Package', header: true },
        { data: 'Version', header: true },
        { data: 'Source', header: true },
      ],
      ...summary.events.map((e) => [
        e.type,
        e.packageName ?? '-',
        e.versionName ?? e.versionCode ?? '-',
        e.source,
      ]),
    ])
    .addRaw(
      `\nSources: ${summary.polled.map((p) => `${p.source}=${p.ok ? 'ok' : 'FAILED'}`).join(', ') || 'none'} · ` +
        `Deliveries: ${summary.deliveries.filter((d) => d.ok).length}/${summary.deliveries.length}`,
    )
    .write();

  const failedDeliveries = summary.deliveries.filter((d) => !d.ok);
  if (failedDeliveries.length) core.setFailed(`${failedDeliveries.length} notification(s) failed`);
  else if (summary.polled.some((p) => !p.ok)) core.warning('One or more sources failed; see log');
}

main().catch((e: unknown) => core.setFailed((e as Error).message));
