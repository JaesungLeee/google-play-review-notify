/**
 * `init`: interactive (or flag-driven) generator for play-review-notify.yml and, for GitHub
 * Actions users, the scheduled workflow. Everything it writes is validated with the real config
 * parser before touching the disk. Secrets are never asked for; only `${ENV_VAR}` references are
 * written.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../core/config';

export const SCHEMA_URL =
  'https://raw.githubusercontent.com/JaesungLeee/google-play-review-notify/main/schemas/config.schema.json';
const DOCS = 'https://github.com/JaesungLeee/google-play-review-notify/blob/main/docs';

export type ChannelKind = 'slack' | 'discord' | 'webhook';
export type Target = 'github-actions' | 'cli';
export type SourceKind = 'email' | 'play-api' | 'store-listing';

export const CHANNEL_KINDS: readonly ChannelKind[] = ['slack', 'discord', 'webhook'];
export const TARGETS: readonly Target[] = ['github-actions', 'cli'];
export const SOURCE_KINDS: readonly SourceKind[] = ['email', 'play-api', 'store-listing'];

export interface InitAnswers {
  apps: Array<{ packageName: string; name?: string }>;
  sources: Record<SourceKind, boolean>;
  channel: ChannelKind;
  target: Target;
}

export interface InitOptions {
  /** Config path relative to cwd. */
  configPath: string;
  /** Workflow path relative to cwd (github-actions target only). */
  workflowPath: string;
  cwd: string;
  force: boolean;
  /** Skip prompts; use flags and defaults. */
  yes: boolean;
  packages?: string[];
  channel?: ChannelKind;
  sources?: SourceKind[];
  target?: Target;
  interactive: boolean;
}

export interface InitIo {
  /** Ask one question; return the raw answer ('' means "use the default"). */
  ask(question: string, defaultValue: string): Promise<string>;
  out(text: string): void;
}

export interface InitResult {
  answers: InitAnswers;
  written: string[];
  skipped: string[];
}

export class InitError extends Error {
  override name = 'InitError';
}

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function parsePackageList(raw: string): string[] {
  const names = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names) {
    if (!PACKAGE_NAME.test(n)) {
      throw new InitError(`"${n}" is not a valid Android package name (e.g. com.example.app)`);
    }
  }
  return [...new Set(names)];
}

export function parseInitChoice<T extends string>(
  raw: string,
  allowed: readonly T[],
  what: string,
): T {
  const v = raw.trim().toLowerCase() as T;
  if (!allowed.includes(v)) {
    throw new InitError(`Unknown ${what} "${raw}". Choose one of: ${allowed.join(', ')}`);
  }
  return v;
}

function yesNo(raw: string, fallback: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '') return fallback;
  if (['y', 'yes', 'true', '1'].includes(v)) return true;
  if (['n', 'no', 'false', '0'].includes(v)) return false;
  throw new InitError(`Please answer y or n (got "${raw}")`);
}

const yamlString = (s: string): string => JSON.stringify(s);

/** Collect answers from flags, then prompts (when interactive and not --yes), then defaults. */
export async function collectAnswers(opts: InitOptions, io: InitIo): Promise<InitAnswers> {
  const prompt = opts.interactive && !opts.yes;
  const ask = async (q: string, d: string): Promise<string> => {
    const v = prompt ? (await io.ask(q, d)).trim() : '';
    return v === '' ? d : v;
  };

  let packages = opts.packages;
  while (!packages || packages.length === 0) {
    if (!prompt) {
      throw new InitError(
        'No package name given. Pass --packages com.example.app (comma-separated for several).',
      );
    }
    try {
      packages = parsePackageList(await ask('Package name(s), comma-separated', ''));
    } catch (e) {
      io.out(`${(e as InitError).message}\n`);
    }
  }

  const apps: InitAnswers['apps'] = [];
  for (const packageName of packages) {
    const name = (await ask(`Display name for ${packageName} as shown in Play Console`, '')).trim();
    apps.push(name ? { packageName, name } : { packageName });
  }

  const target =
    opts.target ??
    parseInitChoice(
      await ask('Where will this run? (github-actions | cli)', 'github-actions'),
      TARGETS,
      'target',
    );

  let enabled: SourceKind[];
  if (opts.sources) enabled = opts.sources;
  else {
    enabled = [];
    if (yesNo(await ask('Watch the Play Console inbox for rejections via Gmail? (y/n)', 'y'), true))
      enabled.push('email');
    if (
      yesNo(
        await ask('Watch the public store listing to detect releases going live? (y/n)', 'y'),
        true,
      )
    )
      enabled.push('store-listing');
    if (
      yesNo(
        await ask(
          'Use the Play Developer API to detect new submissions? (needs a service account) (y/n)',
          'n',
        ),
        false,
      )
    )
      enabled.push('play-api');
  }
  if (enabled.length === 0) {
    throw new InitError('At least one source must be enabled (email, store-listing, play-api).');
  }

  const channel =
    opts.channel ??
    parseInitChoice(
      await ask('Notification channel (slack | discord | webhook)', 'slack'),
      CHANNEL_KINDS,
      'channel',
    );

  return {
    apps,
    sources: {
      email: enabled.includes('email'),
      'play-api': enabled.includes('play-api'),
      'store-listing': enabled.includes('store-listing'),
    },
    channel,
    target,
  };
}

const CHANNEL_ENV: Record<ChannelKind, string> = {
  slack: 'SLACK_WEBHOOK_URL',
  discord: 'DISCORD_WEBHOOK_URL',
  webhook: 'WEBHOOK_URL',
};

/** Environment variables (and therefore CI secrets) the generated config references. */
export function requiredSecrets(a: InitAnswers): string[] {
  const out: string[] = [];
  if (a.sources.email) out.push('GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN');
  if (a.sources['play-api']) out.push('PLAY_SERVICE_ACCOUNT_JSON');
  out.push(CHANNEL_ENV[a.channel]);
  return out;
}

export function renderConfig(a: InitAnswers): string {
  const lines: string[] = [
    `# yaml-language-server: $schema=${SCHEMA_URL}`,
    '# Generated by `play-review-notify init`. Secrets are referenced as ${ENV_VAR}; never write real values here.',
    'version: 1',
    '',
    'apps:',
  ];
  for (const app of a.apps) {
    lines.push(`  - packageName: ${app.packageName}`);
    if (app.name) lines.push(`    name: ${yamlString(app.name)}`);
    lines.push('    tracks: [production]');
  }
  lines.push('', 'sources:', '  email:');
  lines.push(
    `    # REJECTED and POLICY_WARNING from Play Console emails. Setup: ${DOCS}/gmail-oauth.md`,
  );
  if (a.sources.email) {
    lines.push(
      '    enabled: true',
      '    auth:',
      '      clientId: ${GMAIL_CLIENT_ID}',
      '      clientSecret: ${GMAIL_CLIENT_SECRET}',
      '      refreshToken: ${GMAIL_REFRESH_TOKEN}',
      '    lookbackHours: 24',
    );
  } else {
    lines.push(
      '    enabled: false',
      '    # auth:',
      '    #   clientId: ${GMAIL_CLIENT_ID}',
      '    #   clientSecret: ${GMAIL_CLIENT_SECRET}',
      '    #   refreshToken: ${GMAIL_REFRESH_TOKEN}',
    );
  }
  lines.push('  playApi:');
  lines.push(
    `    # SUBMITTED when a new versionCode appears on a track. Setup: ${DOCS}/play-api-setup.md`,
  );
  if (a.sources['play-api']) {
    lines.push('    enabled: true', '    serviceAccountJson: ${PLAY_SERVICE_ACCOUNT_JSON}');
  } else {
    lines.push('    enabled: false', '    # serviceAccountJson: ${PLAY_SERVICE_ACCOUNT_JSON}');
  }
  lines.push('  storeListing:');
  lines.push(
    '    # LIVE (production track) when the public store page appears or its "Updated on" date changes.',
    `    enabled: ${a.sources['store-listing']}`,
    '    locale: en',
    '    country: US',
  );

  const mention = a.channel === 'slack' ? "'<!channel>'" : a.channel === 'discord' ? "'@here'" : '';
  lines.push(
    '',
    'events:',
    `  REJECTED: { enabled: true, mentions: [${mention}] }`,
    '  LIVE: { enabled: true, mergeInto: APPROVED }',
    '  # SUBMITTED: { enabled: true }        # off by default; needs the playApi source or `emit`',
    '  # UNKNOWN_NOTICE: { enabled: true }   # turn on to see Play emails the rules could not classify',
  );

  const env = CHANNEL_ENV[a.channel];
  lines.push('', 'channels:', `  ${a.channel}:`, `    type: ${a.channel}`);
  if (a.channel === 'webhook') {
    lines.push(
      `    url: \${${env}}`,
      '    # secret: ${WEBHOOK_SECRET}   # adds an HMAC-SHA256 X-Play-Review-Signature header',
      '    batch: false',
    );
  } else {
    lines.push(`    webhookUrl: \${${env}}`);
  }
  lines.push(`defaultChannels: [${a.channel}]`);

  lines.push('', 'stateStore:');
  if (a.target === 'github-actions') {
    lines.push('  type: github-cache   # persisted in the Actions cache; no files to commit');
  } else {
    lines.push(
      '  type: file',
      '  path: .play-review-notify/state.json   # add this directory to .gitignore',
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function renderWorkflow(a: InitAnswers, configPath: string): string {
  const secrets = requiredSecrets(a);
  const lines = [
    '# Generated by `play-review-notify init`.',
    '# Runs every 10 minutes; GitHub may delay scheduled runs by a few minutes.',
    'name: Play review notify',
    '',
    'on:',
    '  schedule:',
    "    - cron: '*/10 * * * *'",
    '  workflow_dispatch:',
    '',
    'jobs:',
    '  notify:',
    '    uses: JaesungLeee/google-play-review-notify/.github/workflows/notify.yml@v1',
    '    with:',
    `      config-path: ${configPath}`,
    '    secrets:',
    ...secrets.map((s) => `      ${s}: \${{ secrets.${s} }}`),
    '',
  ];
  return lines.join('\n');
}

export function renderNextSteps(
  a: InitAnswers,
  paths: { config: string; workflow?: string },
): string {
  const secrets = requiredSecrets(a);
  const steps: string[] = [];
  let n = 1;
  const step = (title: string, body: string[] = []) => {
    steps.push(`${n++}. ${title}`);
    for (const b of body) steps.push(`   ${b}`);
  };

  if (a.sources.email) {
    step('Create a Gmail OAuth client and refresh token (one-time, about 10 minutes):', [
      `${DOCS}/gmail-oauth.md`,
      'export GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=...',
      'play-review-notify auth gmail          # prints GMAIL_REFRESH_TOKEN',
    ]);
  }
  if (a.sources['play-api']) {
    step('Create a Play service account with read-only access and download its key:', [
      `${DOCS}/play-api-setup.md`,
    ]);
  }
  const channelHint: Record<ChannelKind, string> = {
    slack: 'Create a Slack Incoming Webhook: https://api.slack.com/messaging/webhooks',
    discord: 'Create a Discord webhook: Server settings → Integrations → Webhooks',
    webhook: 'Point WEBHOOK_URL at your receiver (n8n, Make, Zapier, your server)',
  };
  step(channelHint[a.channel]);

  if (a.target === 'github-actions') {
    step('Add the secrets to your repository (Settings → Secrets and variables → Actions):', [
      ...secrets.map((s) => `gh secret set ${s}`),
    ]);
    step('Verify locally before the first scheduled run:', [
      `export ${secrets.join('=... ')}=...`,
      `play-review-notify -c ${paths.config} doctor`,
      `play-review-notify -c ${paths.config} test-notify`,
    ]);
    step(`Commit ${paths.config}${paths.workflow ? ` and ${paths.workflow}` : ''} and push.`, [
      'The first run only records a baseline; later runs notify.',
      'Trigger one manually from the Actions tab to check it is green.',
    ]);
  } else {
    step('Export the variables and verify:', [
      `export ${secrets.join('=... ')}=...`,
      `play-review-notify -c ${paths.config} doctor`,
      `play-review-notify -c ${paths.config} test-notify`,
      `play-review-notify -c ${paths.config} run --dry-run --verbose`,
    ]);
    step('Schedule `run` (the first run only records a baseline):', [
      `*/10 * * * * cd ${'$'}(pwd) && play-review-notify -c ${paths.config} run >> play-review-notify.log 2>&1`,
      'Add .play-review-notify/ to .gitignore if this directory is a repository.',
    ]);
  }
  return steps.join('\n');
}

/** Parse the generated YAML with the real config parser using placeholder env values. */
export function validateGeneratedConfig(yamlText: string, a: InitAnswers): void {
  const env = Object.fromEntries(
    [...requiredSecrets(a), 'WEBHOOK_SECRET'].map((k) => [k, `https://example.invalid/${k}`]),
  );
  parseConfig(parseYaml(yamlText), env);
}

export async function runInit(opts: InitOptions, io: InitIo): Promise<InitResult> {
  const answers = await collectAnswers(opts, io);
  const configText = renderConfig(answers);
  validateGeneratedConfig(configText, answers);

  const written: string[] = [];
  const skipped: string[] = [];
  const writeFile = (rel: string, text: string) => {
    const abs = resolve(opts.cwd, rel);
    if (existsSync(abs) && !opts.force) {
      if (rel === opts.configPath) {
        throw new InitError(`${rel} already exists. Use --force to overwrite it.`);
      }
      skipped.push(rel);
      return;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    written.push(rel);
  };

  writeFile(opts.configPath, configText);
  let workflow: string | undefined;
  if (answers.target === 'github-actions') {
    writeFile(opts.workflowPath, renderWorkflow(answers, opts.configPath));
    workflow = opts.workflowPath;
  }

  io.out(`\nWrote ${written.join(', ')}\n`);
  for (const s of skipped) io.out(`Kept existing ${s} (use --force to overwrite)\n`);
  io.out('\nNext steps:\n');
  io.out(
    renderNextSteps(
      answers,
      workflow ? { config: opts.configPath, workflow } : { config: opts.configPath },
    ) + '\n',
  );
  return { answers, written, skipped };
}
