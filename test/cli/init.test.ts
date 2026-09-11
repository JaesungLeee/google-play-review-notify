import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildConfigJsonSchema } from '../../scripts/generate-schema';
import { parseConfig } from '../../src/core/config';
import {
  collectAnswers,
  parsePackageList,
  renderConfig,
  renderWorkflow,
  requiredSecrets,
  runInit,
  type InitAnswers,
  type InitIo,
  type InitOptions,
} from '../../src/cli/init';

const validateSchema = new Ajv({ strict: false }).compile(buildConfigJsonSchema());

function scriptedIo(answers: string[]): InitIo & { output: string[]; questions: string[] } {
  const queue = [...answers];
  const io = {
    output: [] as string[],
    questions: [] as string[],
    ask: async (q: string) => {
      io.questions.push(q);
      return queue.shift() ?? '';
    },
    out: (t: string) => {
      io.output.push(t);
    },
  };
  return io;
}

let cwd: string;
const baseOpts = (): InitOptions => ({
  configPath: 'play-review-notify.yml',
  workflowPath: '.github/workflows/play-review-notify.yml',
  cwd,
  force: false,
  yes: false,
  interactive: true,
});

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'prn-init-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('parsePackageList', () => {
  it('splits, trims, dedupes and validates', () => {
    expect(parsePackageList('com.a.app, com.b.app com.a.app')).toEqual(['com.a.app', 'com.b.app']);
    expect(() => parsePackageList('notapackage')).toThrow(/not a valid Android package name/);
    expect(() => parsePackageList('com.1bad')).toThrow(/not a valid/);
  });
});

describe('collectAnswers', () => {
  it('walks the prompts and applies defaults for empty answers', async () => {
    const io = scriptedIo(['com.example.app', 'Example', '', '', '', '']);
    const a = await collectAnswers(baseOpts(), io);
    expect(a).toEqual({
      apps: [{ packageName: 'com.example.app', name: 'Example' }],
      sources: { email: true, 'play-api': true },
      channel: 'slack',
      target: 'github-actions',
    });
  });

  it('re-asks after an invalid package name', async () => {
    const io = scriptedIo(['nope', 'com.example.app', '', 'cli', 'y', 'n', 'discord']);
    const a = await collectAnswers(baseOpts(), io);
    expect(io.output.join('')).toMatch(/not a valid Android package name/);
    expect(a.apps).toEqual([{ packageName: 'com.example.app' }]);
    expect(a.sources).toEqual({ email: false, 'play-api': true });
    expect(a.channel).toBe('discord');
    expect(a.target).toBe('cli');
  });

  it('uses flags without prompting when --yes is set', async () => {
    const io = scriptedIo([]);
    const a = await collectAnswers(
      { ...baseOpts(), yes: true, packages: ['com.a.app', 'com.b.app'], channel: 'webhook' },
      io,
    );
    expect(io.questions).toEqual([]);
    expect(a.apps.map((x) => x.packageName)).toEqual(['com.a.app', 'com.b.app']);
    expect(a.channel).toBe('webhook');
    expect(a.sources).toEqual({ email: true, 'play-api': true });
  });

  it('fails clearly when not interactive and no packages were given', async () => {
    await expect(
      collectAnswers({ ...baseOpts(), interactive: false }, scriptedIo([])),
    ).rejects.toThrow(/--packages/);
  });

  it('rejects a configuration with no sources', async () => {
    await expect(
      collectAnswers(
        { ...baseOpts(), yes: true, packages: ['com.a.app'], sources: [] },
        scriptedIo([]),
      ),
    ).rejects.toThrow(/At least one source/);
  });
});

const combos: InitAnswers[] = [];
for (const channel of ['slack', 'discord', 'webhook'] as const)
  for (const target of ['github-actions', 'cli'] as const)
    for (const email of [true, false])
      for (const playApi of [true, false])
        combos.push({
          apps: [{ packageName: 'com.example.app', name: 'Example\'s "App"' }],
          sources: { email, 'play-api': playApi },
          channel,
          target,
        });

describe('renderConfig', () => {
  it.each(
    combos.map((c) => [
      `${c.channel}/${c.target}/email=${c.sources.email}/api=${c.sources['play-api']}`,
      c,
    ]),
  )('produces a config the parser and the JSON schema accept (%s)', (_label, a) => {
    const text = renderConfig(a);
    const raw = parseYaml(text);
    expect(validateSchema(raw), JSON.stringify(validateSchema.errors)).toBe(true);
    const env = Object.fromEntries(requiredSecrets(a).map((k) => [k, `https://x.invalid/${k}`]));
    const config = parseConfig(raw, env);
    expect(config.sources.email.enabled).toBe(a.sources.email);
    expect(config.sources.playApi.enabled).toBe(a.sources['play-api']);
    expect(Object.keys(config.channels)).toEqual([a.channel]);
    expect(config.stateStore.type).toBe(a.target === 'github-actions' ? 'github-cache' : 'file');
    expect(config.apps[0]?.name).toBe('Example\'s "App"');
    // Disabled sources must not reference env vars that the user has not set.
    expect(() => parseConfig(raw, env)).not.toThrow();
  });

  it('starts with the schema comment and only references env vars, never values', () => {
    const text = renderConfig(combos[0]!);
    expect(text.split('\n')[0]).toMatch(/^# yaml-language-server: \$schema=https:\/\//);
    expect(text).toMatch(/webhookUrl: \$\{SLACK_WEBHOOK_URL\}/);
  });
});

describe('renderWorkflow', () => {
  it('passes exactly the secrets the config references', () => {
    const a: InitAnswers = {
      apps: [{ packageName: 'com.example.app' }],
      sources: { email: true, 'play-api': true },
      channel: 'discord',
      target: 'github-actions',
    };
    const wf = parseYaml(renderWorkflow(a, 'cfg.yml')) as {
      jobs: {
        notify: {
          uses: string;
          permissions: Record<string, string>;
          with: Record<string, string>;
          secrets: Record<string, string>;
        };
      };
    };
    expect(wf.jobs.notify.permissions).toEqual({ contents: 'read', actions: 'write' });
    expect(wf.jobs.notify.uses).toBe(
      'JaesungLeee/google-play-review-notify/.github/workflows/notify.yml@v1',
    );
    expect(wf.jobs.notify.with['config-path']).toBe('cfg.yml');
    expect(Object.keys(wf.jobs.notify.secrets)).toEqual([
      'GMAIL_CLIENT_ID',
      'GMAIL_CLIENT_SECRET',
      'GMAIL_REFRESH_TOKEN',
      'PLAY_SERVICE_ACCOUNT_JSON',
      'DISCORD_WEBHOOK_URL',
    ]);
  });
});

describe('runInit', () => {
  it('writes the config and workflow for the github-actions target and prints next steps', async () => {
    const io = scriptedIo([]);
    const result = await runInit({ ...baseOpts(), yes: true, packages: ['com.example.app'] }, io);
    expect(result.written).toEqual([
      'play-review-notify.yml',
      '.github/workflows/play-review-notify.yml',
    ]);
    expect(existsSync(join(cwd, '.github/workflows/play-review-notify.yml'))).toBe(true);
    const text = io.output.join('');
    expect(text).toContain('gh secret set GMAIL_REFRESH_TOKEN');
    expect(text).toContain('gh secret set SLACK_WEBHOOK_URL');
    expect(text).toContain('auth gmail');
  });

  it('writes only the config for the cli target and suggests a cron line', async () => {
    const io = scriptedIo([]);
    const result = await runInit(
      {
        ...baseOpts(),
        yes: true,
        packages: ['com.example.app'],
        target: 'cli',
        sources: ['play-api'],
      },
      io,
    );
    expect(result.written).toEqual(['play-review-notify.yml']);
    const text = io.output.join('');
    expect(text).toContain('*/10 * * * *');
    expect(text).not.toContain('auth gmail');
    const written = readFileSync(join(cwd, 'play-review-notify.yml'), 'utf8');
    expect(written).toContain('type: file');
  });

  it('refuses to overwrite the config without --force but keeps an existing workflow quietly', async () => {
    writeFileSync(join(cwd, 'play-review-notify.yml'), 'version: 1\n');
    const opts = { ...baseOpts(), yes: true, packages: ['com.example.app'] };
    await expect(runInit(opts, scriptedIo([]))).rejects.toThrow(/already exists/);

    const io = scriptedIo([]);
    const forced = await runInit({ ...opts, force: true }, io);
    expect(forced.written).toContain('play-review-notify.yml');

    writeFileSync(join(cwd, '.github/workflows/play-review-notify.yml'), 'name: mine\n');
    const again = await runInit({ ...opts, force: false, configPath: 'other.yml' }, io);
    expect(again.skipped).toEqual(['.github/workflows/play-review-notify.yml']);
    expect(readFileSync(join(cwd, '.github/workflows/play-review-notify.yml'), 'utf8')).toBe(
      'name: mine\n',
    );
  });
});
