#!/usr/bin/env node
/** CLI entry. See docs/PRD_ko.md §5.7 for commands and exit codes. */
import { Command } from 'commander';
import { collectSecrets, loadConfigFile, ConfigError, type Config } from '../core/config';
import { createConsoleLogger, type LogLevel } from '../core/logger';
import { PACKAGE_VERSION } from '../core/version';
import { runOnce } from '../core/run';
import type { ReviewEvent, RunSummary } from '../core/types';
import { createDefaultNotifiers } from '../notifiers';
import { createSources, ManualSourceAdapter } from '../sources';
import { authorizeGmail } from '../sources/email/oauth';
import { createStateStore, FileStateStore, NoneStateStore } from '../state';
import { renderMessage } from '../templates';

const VERSION = PACKAGE_VERSION;

export const EXIT = { OK: 0, CONFIG: 1, SOURCE_PARTIAL: 2, NOTIFY_FAILED: 3 } as const;

interface GlobalOpts {
  config: string;
  json?: boolean;
  verbose?: boolean;
}

function logger(opts: GlobalOpts, config?: Config) {
  const level: LogLevel = opts.verbose ? 'debug' : 'info';
  return createConsoleLogger({
    level,
    ...(opts.json ? { json: true } : {}),
    redact: config ? collectSecrets(config) : [],
  });
}

function loadOrExit(opts: GlobalOpts): Config {
  try {
    return loadConfigFile(opts.config);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(EXIT.CONFIG);
  }
}

function exitCodeFor(summary: RunSummary): number {
  if (summary.deliveries.some((d) => !d.ok)) return EXIT.NOTIFY_FAILED;
  if (summary.polled.some((p) => !p.ok)) return EXIT.SOURCE_PARTIAL;
  return EXIT.OK;
}

const program = new Command()
  .name('play-review-notify')
  .description('Detect Google Play review outcomes and notify Slack, Discord, or any webhook.')
  .version(VERSION)
  .option('-c, --config <path>', 'config file (YAML or JSON)', 'play-review-notify.yml')
  .option('--json', 'structured JSON logs and output')
  .option('-v, --verbose', 'debug logging');

program
  .command('run')
  .description('Poll all enabled sources once, notify, and exit')
  .option('--dry-run', 'render messages but do not send or save state')
  .option('--state-store <type>', 'override state store: file | none')
  .action(async (cmd: { dryRun?: boolean; stateStore?: string }) => {
    const g = program.opts<GlobalOpts>();
    const config = loadOrExit(g);
    const log = logger(g, config);
    const stateStore =
      cmd.stateStore === 'none'
        ? new NoneStateStore()
        : cmd.stateStore === 'file'
          ? new FileStateStore()
          : await createStateStore(config, log);
    const summary = await runOnce({
      config,
      sources: createSources(config, log, { version: VERSION }),
      notifiers: createDefaultNotifiers({ version: VERSION }),
      stateStore,
      logger: log,
      dryRun: cmd.dryRun ?? false,
    });
    if (g.json) process.stdout.write(JSON.stringify({ events: summary.events, summary }) + '\n');
    else
      log.info(
        `Done: ${summary.events.length} new event(s), ${summary.deliveries.filter((d) => d.ok).length} delivered` +
          (summary.baseline ? ' (baseline run, notifications suppressed)' : ''),
      );
    process.exit(exitCodeFor(summary));
  });

program
  .command('test-notify')
  .description('Send a sample event to configured channels')
  .option('-t, --type <type>', 'event type', 'REJECTED')
  .option('-p, --package <packageName>', 'package name (defaults to first app in config)')
  .action(async (cmd: { type: ReviewEvent['type']; package?: string }) => {
    const g = program.opts<GlobalOpts>();
    const config = loadOrExit(g);
    const log = logger(g, config);
    const app = config.apps.find((a) => a.packageName === cmd.package) ?? config.apps[0];
    if (!app) return process.exit(EXIT.CONFIG);
    const event: ReviewEvent = {
      id: `manual:test:${Date.now()}`,
      type: cmd.type,
      packageName: app.packageName,
      track: app.tracks[0] ?? 'production',
      versionCode: '1',
      versionName: '0.0.1-test',
      reason: 'This is a test notification from google-play-review-notify.',
      source: 'manual',
      confidence: 'high',
      observedAt: new Date().toISOString(),
    };
    if (app.name) event.appName = app.name;
    const message = renderMessage(config, event, app);
    const notifiers = createDefaultNotifiers({ version: VERSION });
    const targets = app.channels ?? config.defaultChannels;
    let failed = false;
    for (const name of targets) {
      const channel = config.channels[name];
      const notifier = channel && notifiers.get(channel.type);
      if (!channel || !notifier) {
        log.warn(`Channel ${name} is missing or has no notifier`);
        continue;
      }
      try {
        await notifier.send(message, { ...channel, name });
        log.info(`Sent test ${event.type} to ${name}`);
      } catch (e) {
        failed = true;
        log.error(`Failed to send to ${name}: ${(e as Error).message}`);
      }
    }
    process.exit(failed ? EXIT.NOTIFY_FAILED : EXIT.OK);
  });

program
  .command('emit')
  .description('Emit an event from an external pipeline (e.g. SUBMITTED right after upload)')
  .requiredOption('-t, --type <type>', 'event type')
  .requiredOption('-p, --package <packageName>', 'package name')
  .option('--track <track>', 'track', 'production')
  .option('--version-code <code>', 'version code')
  .option('--version-name <name>', 'version name')
  .option('--dry-run', 'do not send or save state')
  .action(
    async (cmd: {
      type: ReviewEvent['type'];
      package: string;
      track: string;
      versionCode?: string;
      versionName?: string;
      dryRun?: boolean;
    }) => {
      const g = program.opts<GlobalOpts>();
      const config = loadOrExit(g);
      const log = logger(g, config);
      const { manualEventId } = await import('../sources/manual');
      const event: ReviewEvent = {
        id: manualEventId({
          type: cmd.type,
          packageName: cmd.package,
          track: cmd.track,
          ...(cmd.versionCode ? { versionCode: cmd.versionCode } : {}),
        }),
        type: cmd.type,
        packageName: cmd.package,
        track: cmd.track,
        source: 'manual',
        confidence: 'high',
        observedAt: new Date().toISOString(),
      };
      if (cmd.versionCode) event.versionCode = cmd.versionCode;
      if (cmd.versionName) event.versionName = cmd.versionName;
      const summary = await runOnce({
        config,
        sources: [new ManualSourceAdapter([event])],
        notifiers: createDefaultNotifiers({ version: VERSION }),
        stateStore: await createStateStore(config, log),
        logger: log,
        dryRun: cmd.dryRun ?? false,
      });
      process.exit(exitCodeFor(summary));
    },
  );

const state = program.command('state').description('Inspect or reset persisted state');
state.command('show').action(async () => {
  const g = program.opts<GlobalOpts>();
  const config = loadOrExit(g);
  const store = await createStateStore(config, logger(g, config));
  const s = await store.load();
  process.stdout.write(JSON.stringify(s, null, 2) + '\n');
});
state
  .command('reset')
  .description('Forget all state; the next run records a fresh baseline')
  .action(async () => {
    const g = program.opts<GlobalOpts>();
    const config = loadOrExit(g);
    const log = logger(g, config);
    if (config.stateStore.type !== 'file') {
      log.error('state reset is only supported for the file state store in this version');
      process.exit(EXIT.CONFIG);
    }
    const { rmSync } = await import('node:fs');
    rmSync(new FileStateStore(config.stateStore.path).path, { force: true });
    log.info('State removed');
  });

for (const [name, phase] of [
  ['init', 'Phase 2'],
  ['doctor', 'Phase 2'],
] as const) {
  program
    .command(name)
    .description(`(not implemented yet, planned for ${phase})`)
    .action(() => {
      process.stderr.write(
        `${name} is not implemented yet (planned for ${phase}; see docs/PRD_ko.md §5.7)\n`,
      );
      process.exit(EXIT.CONFIG);
    });
}

program
  .command('auth')
  .argument('<provider>', 'gmail')
  .description('Obtain an OAuth refresh token (one-time setup). See docs/gmail-oauth.md')
  .option('--client-id <id>', 'OAuth client id (default: $GMAIL_CLIENT_ID)')
  .option('--client-secret <secret>', 'OAuth client secret (default: $GMAIL_CLIENT_SECRET)')
  .option('--port <port>', 'local callback port (default: a free port)', (v) => Number(v))
  .option('--no-open', 'print the consent URL instead of opening a browser')
  .action(
    async (
      provider: string,
      cmd: { clientId?: string; clientSecret?: string; port?: number; open: boolean },
    ) => {
      const g = program.opts<GlobalOpts>();
      if (provider !== 'gmail') {
        process.stderr.write(`Unknown provider "${provider}". Supported: gmail\n`);
        process.exit(EXIT.CONFIG);
      }
      const clientId = cmd.clientId ?? process.env['GMAIL_CLIENT_ID'];
      const clientSecret = cmd.clientSecret ?? process.env['GMAIL_CLIENT_SECRET'];
      if (!clientId || !clientSecret) {
        process.stderr.write(
          'Missing OAuth client. Pass --client-id/--client-secret or set GMAIL_CLIENT_ID and ' +
            'GMAIL_CLIENT_SECRET (create a "Desktop app" OAuth client; see docs/gmail-oauth.md).\n',
        );
        process.exit(EXIT.CONFIG);
      }
      const err = (m: string) => process.stderr.write(m + '\n');
      try {
        const result = await authorizeGmail({
          clientId,
          clientSecret,
          port: cmd.port ?? 0,
          openBrowser: cmd.open,
          onAuthUrl: (url) =>
            err(
              (cmd.open ? 'Opening your browser. If it does not open, visit:' : 'Visit:') +
                `\n\n  ${url}\n\nWaiting for Google to redirect back to this machine...`,
            ),
        });
        if (g.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          err(
            `\nAuthorized${result.emailAddress ? ` as ${result.emailAddress}` : ''}. ` +
              'Add this to your environment or CI secrets:\n',
          );
          process.stdout.write(`GMAIL_REFRESH_TOKEN=${result.refreshToken}\n`);
          err(
            '\nKeep it secret. If the OAuth consent screen is still in "Testing", the token ' +
              'expires after 7 days; publish the app to production to make it permanent.',
          );
        }
        process.exit(EXIT.OK);
      } catch (e) {
        err(`auth gmail failed: ${(e as Error).message}`);
        process.exit(EXIT.CONFIG);
      }
    },
  );

program.parseAsync(process.argv).catch((e: unknown) => {
  const msg = e instanceof ConfigError ? e.message : ((e as Error).stack ?? String(e));
  process.stderr.write(msg + '\n');
  process.exit(e instanceof ConfigError ? EXIT.CONFIG : EXIT.NOTIFY_FAILED);
});
