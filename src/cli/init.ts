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
import { messages, type Lang, type Messages } from './i18n';

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
  /** Language of prompts and messages (not of the generated files). Default: English. */
  lang?: Lang;
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

export function parsePackageList(raw: string, lang: Lang = 'en'): string[] {
  const names = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names) {
    if (!PACKAGE_NAME.test(n)) {
      throw new InitError(messages(lang).init.invalidPackage(n));
    }
  }
  return [...new Set(names)];
}

export type InitChoiceKind = 'target' | 'channel' | 'source';

export function parseInitChoice<T extends string>(
  raw: string,
  allowed: readonly T[],
  what: InitChoiceKind,
  lang: Lang = 'en',
): T {
  const v = raw.trim().toLowerCase() as T;
  if (!allowed.includes(v)) {
    const m = messages(lang).init;
    throw new InitError(m.unknownChoice(m.choiceKinds[what], raw, allowed.join(', ')));
  }
  return v;
}

function yesNo(raw: string, fallback: boolean, m: Messages['init']): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '') return fallback;
  if (['y', 'yes', 'true', '1'].includes(v)) return true;
  if (['n', 'no', 'false', '0'].includes(v)) return false;
  throw new InitError(m.answerYesNo(raw));
}

const yamlString = (s: string): string => JSON.stringify(s);

/** Collect answers from flags, then prompts (when interactive and not --yes), then defaults. */
export async function collectAnswers(opts: InitOptions, io: InitIo): Promise<InitAnswers> {
  const lang = opts.lang ?? 'en';
  const m = messages(lang).init;
  const prompt = opts.interactive && !opts.yes;
  const ask = async (q: string, d: string): Promise<string> => {
    const v = prompt ? (await io.ask(q, d)).trim() : '';
    return v === '' ? d : v;
  };

  let packages = opts.packages;
  while (!packages || packages.length === 0) {
    if (!prompt) {
      throw new InitError(m.noPackages);
    }
    try {
      packages = parsePackageList(await ask(m.askPackages, ''), lang);
    } catch (e) {
      io.out(`${(e as InitError).message}\n`);
    }
  }

  const apps: InitAnswers['apps'] = [];
  for (const packageName of packages) {
    const name = (await ask(m.askDisplayName(packageName), '')).trim();
    apps.push(name ? { packageName, name } : { packageName });
  }

  const target =
    opts.target ??
    parseInitChoice(await ask(m.askTarget, 'github-actions'), TARGETS, 'target', lang);

  let enabled: SourceKind[];
  if (opts.sources) enabled = opts.sources;
  else {
    enabled = [];
    if (yesNo(await ask(m.askEmail, 'y'), true, m)) enabled.push('email');
    if (yesNo(await ask(m.askStoreListing, 'y'), true, m)) enabled.push('store-listing');
    if (yesNo(await ask(m.askPlayApi, 'n'), false, m)) enabled.push('play-api');
  }
  if (enabled.length === 0) {
    throw new InitError(m.noSources);
  }

  const channel =
    opts.channel ??
    parseInitChoice(await ask(m.askChannel, 'slack'), CHANNEL_KINDS, 'channel', lang);

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
    '    # A called workflow cannot request more than the caller grants; repository defaults are read-only.',
    '    permissions:',
    '      contents: read',
    '      actions: write # state lives in the Actions cache',
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
  lang: Lang = 'en',
): string {
  const { init: m, docs } = messages(lang);
  const secrets = requiredSecrets(a);
  const steps: string[] = [];
  let n = 1;
  const step = (title: string, body: string[] = []) => {
    steps.push(`${n++}. ${title}`);
    for (const b of body) steps.push(`   ${b}`);
  };

  if (a.sources.email) {
    step(m.stepGmail, [
      `${DOCS}/${docs.gmailOauth}`,
      'export GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=...',
      `play-review-notify auth gmail          # ${m.stepGmailAuthComment}`,
    ]);
  }
  if (a.sources['play-api']) {
    step(m.stepPlayApi, [`${DOCS}/${docs.playApiSetup}`]);
  }
  step(m.stepChannel[a.channel]);

  if (a.target === 'github-actions') {
    step(m.stepSecrets, [...secrets.map((s) => `gh secret set ${s}`)]);
    step(m.stepVerifyBeforeSchedule, [
      `export ${secrets.join('=... ')}=...`,
      `play-review-notify -c ${paths.config} doctor`,
      `play-review-notify -c ${paths.config} test-notify`,
    ]);
    step(m.stepCommit(paths.config, paths.workflow), [m.stepCommitBaseline, m.stepCommitTrigger]);
  } else {
    step(m.stepExportVerify, [
      `export ${secrets.join('=... ')}=...`,
      `play-review-notify -c ${paths.config} doctor`,
      `play-review-notify -c ${paths.config} test-notify`,
      `play-review-notify -c ${paths.config} run --dry-run --verbose`,
    ]);
    step(m.stepSchedule, [
      `*/10 * * * * cd ${'$'}(pwd) && play-review-notify -c ${paths.config} run >> play-review-notify.log 2>&1`,
      m.stepGitignore,
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
  const lang = opts.lang ?? 'en';
  const m = messages(lang).init;
  const answers = await collectAnswers(opts, io);
  const configText = renderConfig(answers);
  validateGeneratedConfig(configText, answers);

  const written: string[] = [];
  const skipped: string[] = [];
  const writeFile = (rel: string, text: string) => {
    const abs = resolve(opts.cwd, rel);
    if (existsSync(abs) && !opts.force) {
      if (rel === opts.configPath) {
        throw new InitError(m.alreadyExists(rel));
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

  io.out(m.wrote(written.join(', ')));
  for (const s of skipped) io.out(m.keptExisting(s));
  io.out(m.nextSteps);
  io.out(
    renderNextSteps(
      answers,
      workflow ? { config: opts.configPath, workflow } : { config: opts.configPath },
      lang,
    ) + '\n',
  );
  return { answers, written, skipped };
}
