/**
 * `doctor`: checks everything a run depends on and explains what to fix, without sending any
 * notification. Each probe is independent and read-only. Check ids are stable and language
 * independent; messages and hints follow `opts.lang`.
 */
import { existsSync, mkdirSync, accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Config } from '../core/config';
import { buildQuery, createGmailClient, type GmailClient } from '../sources/email/gmail';
import { createPlayApiClient, type PlayApiClient } from '../sources/play-api/client';
import { messages, type Lang, type Messages } from './i18n';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  /** Stable identifier, e.g. "gmail.auth". */
  id: string;
  status: CheckStatus;
  /** One line, human readable. */
  message: string;
  /** What to do about it, when not ok. */
  hint?: string;
}

export interface DoctorOptions {
  /** Injected for tests. */
  gmailClient?: (auth: NonNullable<Config['sources']['email']['auth']>) => GmailClient;
  playClient?: (serviceAccount: string) => PlayApiClient;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** Language of messages and hints. Default: English. */
  lang?: Lang;
}

/** Message table plus the doc file names for the chosen language. */
type Texts = { m: Messages['doctor']; docs: Messages['docs'] };

const LOOKBACK_DAYS = 7;

export async function runDoctor(config: Config, opts: DoctorOptions = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const { doctor: m, docs } = messages(opts.lang ?? 'en');
  const t: Texts = { m, docs };

  out.push(checkNode(t));
  out.push(...checkConfig(config, t));
  out.push(...(await checkGmail(config, opts, now, t)));
  out.push(...(await checkPlayApi(config, opts, t)));
  out.push(...checkChannels(config, t));
  out.push(...(await checkStateStore(config, env, t)));
  return out;
}

function checkNode({ m }: Texts): CheckResult {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 20
    ? { id: 'node', status: 'ok', message: m.nodeOk(process.versions.node) }
    : {
        id: 'node',
        status: 'fail',
        message: m.nodeTooOld(process.versions.node),
        hint: m.nodeHint,
      };
}

function checkConfig(config: Config, { m, docs }: Texts): CheckResult[] {
  const results: CheckResult[] = [];
  const apps = config.apps.map((a) => a.packageName).join(', ');
  results.push({
    id: 'config.apps',
    status: 'ok',
    message: m.apps(config.apps.length, apps),
  });

  const enabled = (['email', 'playApi'] as const).filter((s) => config.sources[s].enabled);
  results.push(
    enabled.length
      ? { id: 'config.sources', status: 'ok', message: m.sourcesEnabled(enabled.join(', ')) }
      : { id: 'config.sources', status: 'fail', message: m.noSource, hint: m.noSourceHint },
  );
  if (!config.sources.playApi.enabled) {
    results.push({
      id: 'config.releases',
      status: 'warn',
      message: m.playOff,
      hint: m.playOffHint(docs.playApiSetup),
    });
  }
  if (!config.sources.email.enabled) {
    results.push({
      id: 'config.rejections',
      status: 'warn',
      message: m.emailOff,
      hint: m.emailOffHint(docs.gmailOauth),
    });
  }

  const enabledEvents = Object.entries(config.events)
    .filter(([, e]) => e.enabled)
    .map(([t]) => t);
  results.push({
    id: 'config.events',
    status: 'ok',
    message: m.eventsOn(enabledEvents.join(', ')),
  });

  const unrouted = config.apps.filter(
    (a) => !(a.channels?.length || config.defaultChannels.length),
  );
  if (unrouted.length) {
    results.push({
      id: 'config.routing',
      status: 'warn',
      message: m.noChannelFor(unrouted.map((a) => a.packageName).join(', ')),
      hint: m.noChannelForHint,
    });
  }
  // Unknown channel names are rejected by the config loader before doctor runs.
  return results;
}

async function checkGmail(
  config: Config,
  opts: DoctorOptions,
  now: Date,
  t: Texts,
): Promise<CheckResult[]> {
  const { m } = t;
  const cfg = config.sources.email;
  if (!cfg.enabled) return [{ id: 'gmail', status: 'skip', message: m.emailDisabled }];
  if (!cfg.auth) {
    return [
      {
        id: 'gmail.auth',
        status: 'fail',
        message: m.emailAuthMissing,
        hint: m.emailAuthMissingHint,
      },
    ];
  }
  const client = (opts.gmailClient ?? createGmailClient)(cfg.auth);
  const results: CheckResult[] = [];
  try {
    const profile = await client.profile?.();
    results.push({
      id: 'gmail.auth',
      status: 'ok',
      message: profile?.emailAddress ? m.authorizedAs(profile.emailAddress) : m.gmailAccepted,
    });
  } catch (e) {
    return [
      {
        id: 'gmail.auth',
        status: 'fail',
        message: m.gmailAuthFailed(msg(e)),
        hint: gmailHint(msg(e), t),
      },
    ];
  }
  try {
    const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
    const messagesFound = await client.search(buildQuery(cfg.senderAllowlist, since), 50);
    results.push(
      messagesFound.length
        ? {
            id: 'gmail.inbox',
            status: 'ok',
            message: m.gmailEmails(messagesFound.length, LOOKBACK_DAYS),
          }
        : {
            id: 'gmail.inbox',
            status: 'warn',
            message: m.gmailNoEmails(LOOKBACK_DAYS),
            hint: m.gmailNoEmailsHint,
          },
    );
  } catch (e) {
    results.push({
      id: 'gmail.inbox',
      status: 'fail',
      message: m.gmailSearchFailed(msg(e)),
      hint: gmailHint(msg(e), t),
    });
  }
  return results;
}

function gmailHint(text: string, { m, docs }: Texts): string {
  if (/invalid_grant|token has been expired or revoked/i.test(text)) return m.gmailHintExpired;
  if (/invalid_client|unauthorized_client/i.test(text)) return m.gmailHintClient;
  if (/insufficient|scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) return m.gmailHintScope;
  if (/accessNotConfigured|Gmail API has not been used/i.test(text))
    return m.gmailHintApi(docs.gmailOauth);
  return m.gmailHintDefault(docs.gmailOauth);
}

async function checkPlayApi(config: Config, opts: DoctorOptions, t: Texts): Promise<CheckResult[]> {
  const { m, docs } = t;
  const cfg = config.sources.playApi;
  if (!cfg.enabled) return [{ id: 'play-api', status: 'skip', message: m.playDisabled }];
  if (!cfg.serviceAccountJson) {
    return [
      {
        id: 'play-api.auth',
        status: 'fail',
        message: m.playKeyMissing,
        hint: m.playKeyMissingHint(docs.playApiSetup),
      },
    ];
  }
  let client: PlayApiClient;
  try {
    client = (opts.playClient ?? createPlayApiClient)(cfg.serviceAccountJson);
  } catch (e) {
    return [
      {
        id: 'play-api.auth',
        status: 'fail',
        message: m.playKeyUnreadable(msg(e)),
        hint: m.playKeyUnreadableHint,
      },
    ];
  }
  const results: CheckResult[] = [];
  for (const app of config.apps) {
    const parts: string[] = [];
    const failed: string[] = [];
    let lastError = '';
    for (const track of app.tracks) {
      try {
        const releases = await client.listReleases(app.packageName, track);
        const items = releases.map(
          (r) => `${r.name ?? '?'}:${r.state}(${r.versionCodes.join(',') || '-'})`,
        );
        parts.push(`${track}=[${items.join(' ')}]`);
      } catch (e) {
        failed.push(track);
        lastError = msg(e);
      }
    }
    if (failed.length === app.tracks.length && app.tracks.length) {
      results.push({
        id: `play-api.${app.packageName}`,
        status: 'fail',
        message: `${app.packageName}: ${lastError}`,
        hint: playHint(lastError, t),
      });
      continue;
    }
    results.push({
      id: `play-api.${app.packageName}`,
      status: failed.length ? 'warn' : 'ok',
      message: m.playTracks(app.packageName, parts.join(' ')),
      ...(failed.length ? { hint: `${m.playTracksFailed(failed.join(', '))} ${lastError}` } : {}),
    });
  }
  return results;
}

function playHint(text: string, { m, docs }: Texts): string {
  if (/accessNotConfigured|has not been used|is disabled/i.test(text))
    return m.playHintApi(docs.playApiSetup);
  if (/403|insufficient|permission|not have access/i.test(text)) return m.playHintPermission;
  if (/404|not found/i.test(text)) return m.playHintNotFound;
  if (/invalid_grant|JWT|signature/i.test(text)) return m.playHintKey;
  return m.playHintDefault(docs.playApiSetup);
}

function checkChannels(config: Config, { m }: Texts): CheckResult[] {
  const names = Object.keys(config.channels);
  if (!names.length) {
    return [{ id: 'channels', status: 'warn', message: m.noChannels, hint: m.noChannelsHint }];
  }
  return names.map((name) => {
    const ch = config.channels[name]!;
    const url = ch.type === 'webhook' ? ch.url : ch.webhookUrl;
    let hint: string | undefined;
    if (ch.type === 'slack' && !/^https:\/\/hooks\.slack\.com\/services\//.test(url))
      hint = m.slackUrlHint;
    if (
      ch.type === 'discord' &&
      !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)
    )
      hint = m.discordUrlHint;
    if (!/^https:\/\//.test(url)) hint = m.httpsHint;
    return {
      id: `channels.${name}`,
      status: hint ? 'warn' : 'ok',
      message: m.channel(name, ch.type, Boolean(hint)),
      ...(hint ? { hint: `${hint} ${m.channelHintSuffix}` } : {}),
    };
  });
}

async function checkStateStore(
  config: Config,
  env: NodeJS.ProcessEnv,
  { m }: Texts,
): Promise<CheckResult[]> {
  const cfg = config.stateStore;
  switch (cfg.type) {
    case 'file': {
      const path = resolve(cfg.path);
      try {
        mkdirSync(dirname(path), { recursive: true });
        accessSync(dirname(path), constants.W_OK);
        return [{ id: 'state', status: 'ok', message: m.fileStore(path, existsSync(path)) }];
      } catch (e) {
        return [
          {
            id: 'state',
            status: 'fail',
            message: m.fileStoreFailed(msg(e)),
            hint: m.fileStoreFailedHint,
          },
        ];
      }
    }
    case 'github-cache':
      return [
        env['GITHUB_ACTIONS']
          ? { id: 'state', status: 'ok', message: m.cacheStore }
          : {
              id: 'state',
              status: 'warn',
              message: m.cacheStoreOutside,
              hint: m.cacheStoreOutsideHint,
            },
      ];
    case 'none':
      return [{ id: 'state', status: 'warn', message: m.noneStore, hint: m.noneStoreHint }];
    case 'custom':
      try {
        await import(resolve(cfg.module));
        return [{ id: 'state', status: 'ok', message: m.customStoreLoads(cfg.module) }];
      } catch (e) {
        return [{ id: 'state', status: 'fail', message: m.customStoreFailed(msg(e)) }];
      }
  }
}

export function formatDoctorReport(results: CheckResult[], lang: Lang = 'en'): string {
  const m = messages(lang).doctor;
  const icon: Record<CheckStatus, string> = { ok: '✔', warn: '⚠', fail: '✖', skip: '–' };
  const lines = results.map((r) => {
    const head = `${icon[r.status]} ${r.id}: ${r.message}`;
    return r.hint && r.status !== 'ok' ? `${head}\n    → ${r.hint}` : head;
  });
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  lines.push('', fails ? m.summaryProblems(fails, warns) : m.summaryAllGood(warns));
  return lines.join('\n');
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
