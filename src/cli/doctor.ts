/**
 * `doctor`: checks everything a run depends on and explains what to fix, without sending any
 * notification. Each probe is independent and read-only.
 */
import { existsSync, mkdirSync, accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Config } from '../core/config';
import { fetchWithRetry, HttpError } from '../core/http';
import { buildQuery, createGmailClient, type GmailClient } from '../sources/email/gmail';
import { createPlayApiClient, type PlayApiClient } from '../sources/play-api/client';
import { parseStoreListing, storeListingUrl } from '../sources/store-listing';

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
  version?: string;
  fetchImpl?: typeof fetch;
  /** Injected for tests. */
  gmailClient?: (auth: NonNullable<Config['sources']['email']['auth']>) => GmailClient;
  playClient?: (serviceAccount: string) => PlayApiClient;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

const LOOKBACK_DAYS = 7;

export async function runDoctor(config: Config, opts: DoctorOptions = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();

  out.push(checkNode());
  out.push(...checkConfig(config));
  out.push(...(await checkGmail(config, opts, now)));
  out.push(...(await checkPlayApi(config, opts)));
  out.push(...(await checkStoreListing(config, opts)));
  out.push(...checkChannels(config));
  out.push(...(await checkStateStore(config, env)));
  return out;
}

function checkNode(): CheckResult {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 20
    ? { id: 'node', status: 'ok', message: `Node.js ${process.versions.node}` }
    : {
        id: 'node',
        status: 'fail',
        message: `Node.js ${process.versions.node} is too old`,
        hint: 'Node.js 20 or newer is required.',
      };
}

function checkConfig(config: Config): CheckResult[] {
  const results: CheckResult[] = [];
  const apps = config.apps.map((a) => a.packageName).join(', ');
  results.push({
    id: 'config.apps',
    status: 'ok',
    message: `${config.apps.length} app(s): ${apps}`,
  });

  const enabled = (['email', 'playApi', 'storeListing'] as const).filter(
    (s) => config.sources[s].enabled,
  );
  results.push(
    enabled.length
      ? { id: 'config.sources', status: 'ok', message: `Sources enabled: ${enabled.join(', ')}` }
      : {
          id: 'config.sources',
          status: 'fail',
          message: 'No source is enabled',
          hint: 'Enable sources.email (rejections), sources.storeListing (live), or sources.playApi (submitted).',
        },
  );
  if (!config.sources.email.enabled) {
    results.push({
      id: 'config.rejections',
      status: 'warn',
      message: 'Email source is off, so rejections will not be detected',
      hint: 'Rejections are only announced by email. See docs/gmail-oauth.md.',
    });
  }
  if (!config.sources.storeListing.enabled) {
    results.push({
      id: 'config.live',
      status: 'warn',
      message: 'Store listing source is off, so LIVE will not be detected',
      hint: 'Google sends no approval email and the Play API cannot tell; the public store page is the signal.',
    });
  }

  const enabledEvents = Object.entries(config.events)
    .filter(([, e]) => e.enabled)
    .map(([t]) => t);
  results.push({
    id: 'config.events',
    status: 'ok',
    message: `Events on: ${enabledEvents.join(', ')}`,
  });

  const unrouted = config.apps.filter(
    (a) => !(a.channels?.length || config.defaultChannels.length),
  );
  if (unrouted.length) {
    results.push({
      id: 'config.routing',
      status: 'warn',
      message: `No channel for: ${unrouted.map((a) => a.packageName).join(', ')}`,
      hint: 'Set apps[].channels or defaultChannels; events for these apps are detected but go nowhere.',
    });
  }
  // Unknown channel names are rejected by the config loader before doctor runs.
  return results;
}

async function checkGmail(config: Config, opts: DoctorOptions, now: Date): Promise<CheckResult[]> {
  const cfg = config.sources.email;
  if (!cfg.enabled) return [{ id: 'gmail', status: 'skip', message: 'Email source disabled' }];
  if (!cfg.auth) {
    return [
      {
        id: 'gmail.auth',
        status: 'fail',
        message: 'sources.email.auth is missing',
        hint: 'Set clientId, clientSecret and refreshToken (run `auth gmail`).',
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
      message: profile?.emailAddress
        ? `Authorized as ${profile.emailAddress}`
        : 'Gmail credentials accepted',
    });
  } catch (e) {
    return [
      {
        id: 'gmail.auth',
        status: 'fail',
        message: `Gmail auth failed: ${msg(e)}`,
        hint: gmailHint(msg(e)),
      },
    ];
  }
  try {
    const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
    const messages = await client.search(buildQuery(cfg.senderAllowlist, since), 50);
    results.push(
      messages.length
        ? {
            id: 'gmail.inbox',
            status: 'ok',
            message: `${messages.length} Google Play email(s) in the last ${LOOKBACK_DAYS} days`,
          }
        : {
            id: 'gmail.inbox',
            status: 'warn',
            message: `No Google Play emails in the last ${LOOKBACK_DAYS} days`,
            hint: 'Normal for a quiet account. If Play emails do arrive, check that this is the mailbox that receives them and that Play Console email notifications are on.',
          },
    );
  } catch (e) {
    results.push({
      id: 'gmail.inbox',
      status: 'fail',
      message: `Gmail search failed: ${msg(e)}`,
      hint: gmailHint(msg(e)),
    });
  }
  return results;
}

function gmailHint(m: string): string {
  if (/invalid_grant|token has been expired or revoked/i.test(m))
    return 'The refresh token is expired or revoked. If the OAuth consent screen is in "Testing", tokens expire after 7 days: publish it, then run `auth gmail` again.';
  if (/invalid_client|unauthorized_client/i.test(m))
    return 'Client id or secret is wrong. Copy them again from Google Cloud → Credentials.';
  if (/insufficient|scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(m))
    return 'The token lacks gmail.readonly. Run `auth gmail` again and accept the permission.';
  if (/accessNotConfigured|Gmail API has not been used/i.test(m))
    return 'Enable the Gmail API in the Cloud project (docs/gmail-oauth.md, step 1).';
  return 'See docs/gmail-oauth.md, "Troubleshooting".';
}

async function checkPlayApi(config: Config, opts: DoctorOptions): Promise<CheckResult[]> {
  const cfg = config.sources.playApi;
  if (!cfg.enabled)
    return [{ id: 'play-api', status: 'skip', message: 'Play API source disabled' }];
  if (!cfg.serviceAccountJson) {
    return [
      {
        id: 'play-api.auth',
        status: 'fail',
        message: 'sources.playApi.serviceAccountJson is missing',
        hint: 'Provide the service account key JSON (docs/play-api-setup.md).',
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
        message: `Service account key could not be read: ${msg(e)}`,
        hint: 'serviceAccountJson must be the key JSON content or a path to the key file.',
      },
    ];
  }
  const results: CheckResult[] = [];
  for (const app of config.apps) {
    try {
      const tracks = await client.listTracks(app.packageName);
      const wanted = tracks.filter((t) => app.tracks.includes(t.track));
      const summary = wanted
        .map((t) => `${t.track}=[${t.releases.flatMap((r) => r.versionCodes).join(',') || '-'}]`)
        .join(' ');
      const missingTracks = app.tracks.filter((t) => !tracks.some((x) => x.track === t));
      results.push({
        id: `play-api.${app.packageName}`,
        status: missingTracks.length ? 'warn' : 'ok',
        message: `${app.packageName}: ${summary || 'no configured track found'}`,
        ...(missingTracks.length
          ? {
              hint: `Track(s) not returned by the API: ${missingTracks.join(', ')}. Check apps[].tracks.`,
            }
          : {}),
      });
    } catch (e) {
      results.push({
        id: `play-api.${app.packageName}`,
        status: 'fail',
        message: `${app.packageName}: ${msg(e)}`,
        hint: playHint(msg(e)),
      });
    }
  }
  return results;
}

function playHint(m: string): string {
  if (/accessNotConfigured|has not been used|is disabled/i.test(m))
    return 'Enable the Google Play Android Developer API in the Cloud project (docs/play-api-setup.md, step 1).';
  if (/403|insufficient|permission|not have access/i.test(m))
    return 'Invite the service account in Play Console → Users and permissions with "View app information (read-only)" for this app. Propagation can take several minutes.';
  if (/404|not found/i.test(m))
    return 'The developer account that the service account was invited to does not own this package.';
  if (/invalid_grant|JWT|signature/i.test(m))
    return 'The key JSON is corrupted or the system clock is off. Re-download the key.';
  return 'See docs/play-api-setup.md, "Troubleshooting".';
}

async function checkStoreListing(config: Config, opts: DoctorOptions): Promise<CheckResult[]> {
  const cfg = config.sources.storeListing;
  if (!cfg.enabled)
    return [{ id: 'store-listing', status: 'skip', message: 'Store listing source disabled' }];
  const results: CheckResult[] = [];
  const apps = config.apps.filter((a) => a.tracks.includes('production'));
  if (!apps.length) {
    return [
      {
        id: 'store-listing',
        status: 'warn',
        message: 'No app has the production track; the store listing source has nothing to watch',
        hint: 'Only production releases are visible on the public store page.',
      },
    ];
  }
  for (const app of apps) {
    const url = storeListingUrl(app.packageName, cfg.locale, cfg.country);
    try {
      const res = await fetchWithRetry(
        url,
        {
          method: 'GET',
          headers: { 'user-agent': `google-play-review-notify/${opts.version ?? '0.0.0'}` },
          signal: AbortSignal.timeout(15_000),
        },
        { retries: 0, fetchImpl: opts.fetchImpl ?? fetch },
      );
      const info = parseStoreListing(await res.text());
      results.push(
        info.updatedAt !== undefined
          ? {
              id: `store-listing.${app.packageName}`,
              status: 'ok',
              message: `${app.packageName}: listed, updated ${info.updatedText ?? info.updatedAt}`,
            }
          : {
              id: `store-listing.${app.packageName}`,
              status: 'fail',
              message: `${app.packageName}: page fetched but the "Updated on" date was not found`,
              hint: 'Google may have changed the page format. Please open an issue with the package name.',
            },
      );
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        results.push({
          id: `store-listing.${app.packageName}`,
          status: 'ok',
          message: `${app.packageName}: not published yet (404); LIVE fires when it appears`,
        });
      } else {
        results.push({
          id: `store-listing.${app.packageName}`,
          status: 'fail',
          message: `${app.packageName}: ${msg(e)}`,
          hint: 'Check network access to play.google.com from this machine.',
        });
      }
    }
  }
  return results;
}

function checkChannels(config: Config): CheckResult[] {
  const names = Object.keys(config.channels);
  if (!names.length) {
    return [
      {
        id: 'channels',
        status: 'warn',
        message: 'No channels configured; events will be detected but not delivered',
        hint: 'Add channels (slack, discord, webhook) and defaultChannels.',
      },
    ];
  }
  return names.map((name) => {
    const ch = config.channels[name]!;
    const url = ch.type === 'webhook' ? ch.url : ch.webhookUrl;
    let hint: string | undefined;
    if (ch.type === 'slack' && !/^https:\/\/hooks\.slack\.com\/services\//.test(url))
      hint = 'Slack Incoming Webhook URLs start with https://hooks.slack.com/services/.';
    if (
      ch.type === 'discord' &&
      !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)
    )
      hint = 'Discord webhook URLs start with https://discord.com/api/webhooks/.';
    if (!/^https:\/\//.test(url)) hint = 'Use an https:// URL.';
    return {
      id: `channels.${name}`,
      status: hint ? 'warn' : 'ok',
      message: `${name}: ${ch.type}${hint ? ' (unusual URL)' : ''}`,
      ...(hint ? { hint: `${hint} Run \`test-notify\` to send a real test message.` } : {}),
    };
  });
}

async function checkStateStore(config: Config, env: NodeJS.ProcessEnv): Promise<CheckResult[]> {
  const cfg = config.stateStore;
  switch (cfg.type) {
    case 'file': {
      const path = resolve(cfg.path);
      try {
        mkdirSync(dirname(path), { recursive: true });
        accessSync(dirname(path), constants.W_OK);
        return [
          {
            id: 'state',
            status: 'ok',
            message: `file store at ${path}${existsSync(path) ? '' : ' (no state yet: the first run records a baseline)'}`,
          },
        ];
      } catch (e) {
        return [
          {
            id: 'state',
            status: 'fail',
            message: `file store: ${msg(e)}`,
            hint: 'The directory must be writable.',
          },
        ];
      }
    }
    case 'github-cache':
      return [
        env['GITHUB_ACTIONS']
          ? { id: 'state', status: 'ok', message: 'github-cache store (Actions cache)' }
          : {
              id: 'state',
              status: 'warn',
              message: 'github-cache store selected outside GitHub Actions',
              hint: 'Use stateStore.type: file for local or cron runs.',
            },
      ];
    case 'none':
      return [
        {
          id: 'state',
          status: 'warn',
          message: 'no state store: every run is a baseline and nothing is ever notified',
          hint: 'Use file or github-cache for real runs.',
        },
      ];
    case 'custom':
      try {
        await import(resolve(cfg.module));
        return [{ id: 'state', status: 'ok', message: `custom store module ${cfg.module} loads` }];
      } catch (e) {
        return [{ id: 'state', status: 'fail', message: `custom store: ${msg(e)}` }];
      }
  }
}

export function formatDoctorReport(results: CheckResult[]): string {
  const icon: Record<CheckStatus, string> = { ok: '✔', warn: '⚠', fail: '✖', skip: '–' };
  const lines = results.map((r) => {
    const head = `${icon[r.status]} ${r.id}: ${r.message}`;
    return r.hint && r.status !== 'ok' ? `${head}\n    → ${r.hint}` : head;
  });
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  lines.push(
    '',
    fails ? `${fails} problem(s), ${warns} warning(s)` : `All good, ${warns} warning(s)`,
  );
  return lines.join('\n');
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
