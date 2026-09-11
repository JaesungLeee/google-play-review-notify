#!/usr/bin/env node
/**
 * CLI entry. Exit codes are documented in docs/design.md, "CLI contract".
 *
 * The output language is decided before the program is built (see ./i18n): `--lang`, then
 * $PLAY_REVIEW_NOTIFY_LANG, then a language gate in an interactive terminal, then English.
 */
import { Command, Help } from 'commander';
import { collectSecrets, loadConfigFile, ConfigError, type Config } from '../core/config';
import { createConsoleLogger, type LogLevel } from '../core/logger';
import { PACKAGE_VERSION } from '../core/version';
import { runOnce } from '../core/run';
import type { ReviewEvent, RunSummary } from '../core/types';
import { createDefaultNotifiers } from '../notifiers';
import { createSources, ManualSourceAdapter } from '../sources';
import { authorizeGmail } from '../sources/email/oauth';
import { formatDoctorReport, runDoctor } from './doctor';
import type { Interface as ReadlineInterface } from 'node:readline/promises';
import { LangError, messages, promptLang, resolveLang, type Lang } from './i18n';
import {
  CHANNEL_KINDS,
  parseInitChoice,
  parsePackageList,
  runInit,
  SOURCE_KINDS,
  TARGETS,
  type InitIo,
  type InitOptions,
} from './init';
import { createStateStore, FileStateStore, NoneStateStore } from '../state';
import { renderMessage } from '../templates';

const VERSION = PACKAGE_VERSION;

export const EXIT = { OK: 0, CONFIG: 1, SOURCE_PARTIAL: 2, NOTIFY_FAILED: 3 } as const;

interface GlobalOpts {
  config: string;
  json?: boolean;
  verbose?: boolean;
  lang?: string;
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
    return loadConfigFile(opts.config, process.env, {
      onWarning: (w) => process.stderr.write(`warning: ${w}\n`),
    });
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

/** Questions go to stderr so stdout stays clean for `--json` and redirection. */
async function withReadline<T>(fn: (rl: ReadlineInterface) => Promise<T>): Promise<T> {
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  rl.on('SIGINT', () => {
    rl.close();
    process.stderr.write('\n');
    process.exit(130);
  });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

/** The language gate: asked once, before anything else, only in an interactive terminal. */
function askLangInTerminal(defaultLang: Lang): Promise<Lang> {
  return withReadline(
    (rl) =>
      promptLang(
        { ask: (q) => rl.question(q), out: (t) => process.stderr.write(t) },
        defaultLang,
      ).catch(() => defaultLang), // stdin closed mid-question: fall back to the default
  );
}

export function buildProgram(lang: Lang, interactive: boolean): Command {
  const { cli: m, help, docs } = messages(lang);

  const program = new Command()
    .name('play-review-notify')
    .description(m.description)
    .version(VERSION, '-V, --version', help.versionOption)
    .helpOption('-h, --help', help.helpOption)
    .helpCommand('help [command]', help.helpCommand)
    .configureHelp({
      styleTitle: (title) => help.titles[title] ?? title,
      optionDescription(option) {
        return Help.prototype.optionDescription
          .call(this, option)
          .replace('(default: ', `(${help.defaultLabel}`);
      },
    })
    .option('-c, --config <path>', m.optConfig, 'play-review-notify.yml')
    .option('--json', m.optJson)
    .option('-v, --verbose', m.optVerbose)
    .option('--lang <lang>', m.optLang);

  program
    .command('run')
    .description(m.run)
    .option('--dry-run', m.runDryRun)
    .option('--state-store <type>', m.runStateStore)
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
        sources: createSources(config, log),
        notifiers: createDefaultNotifiers({ version: VERSION }),
        stateStore,
        logger: log,
        dryRun: cmd.dryRun ?? false,
      });
      if (g.json) process.stdout.write(JSON.stringify({ events: summary.events, summary }) + '\n');
      else
        log.info(
          m.runDone(
            summary.events.length,
            summary.deliveries.filter((d) => d.ok).length,
            Boolean(summary.baseline),
          ),
        );
      process.exit(exitCodeFor(summary));
    });

  program
    .command('test-notify')
    .description(m.testNotify)
    .option('-t, --type <type>', m.optEventType, 'REJECTED')
    .option('-p, --package <packageName>', m.optPackageDefault)
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
        reason: m.testReason,
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
          log.warn(m.channelMissing(name));
          continue;
        }
        try {
          await notifier.send(message, { ...channel, name });
          log.info(m.sentTest(event.type, name));
        } catch (e) {
          failed = true;
          log.error(m.sendFailed(name, (e as Error).message));
        }
      }
      process.exit(failed ? EXIT.NOTIFY_FAILED : EXIT.OK);
    });

  program
    .command('emit')
    .description(m.emit)
    .requiredOption('-t, --type <type>', m.optEventType)
    .requiredOption('-p, --package <packageName>', m.optPackage)
    .option('--track <track>', m.optTrack, 'production')
    .option('--version-code <code>', m.optVersionCode)
    .option('--version-name <name>', m.optVersionName)
    .option('--dry-run', m.emitDryRun)
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

  const state = program.command('state').description(m.state);
  state
    .command('show')
    .description(m.stateShow)
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      const config = loadOrExit(g);
      const store = await createStateStore(config, logger(g, config));
      const s = await store.load();
      process.stdout.write(JSON.stringify(s, null, 2) + '\n');
    });
  state
    .command('reset')
    .description(m.stateReset)
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      const config = loadOrExit(g);
      const log = logger(g, config);
      if (config.stateStore.type !== 'file') {
        log.error(m.stateResetUnsupported);
        process.exit(EXIT.CONFIG);
      }
      const { rmSync } = await import('node:fs');
      rmSync(new FileStateStore(config.stateStore.path).path, { force: true });
      log.info(m.stateRemoved);
    });

  program
    .command('doctor')
    .description(m.doctor)
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      const config = loadOrExit(g);
      const results = await runDoctor(config, { lang });
      if (g.json) process.stdout.write(JSON.stringify(results, null, 2) + '\n');
      else process.stdout.write(formatDoctorReport(results, lang) + '\n');
      process.exit(results.some((r) => r.status === 'fail') ? EXIT.CONFIG : EXIT.OK);
    });

  program
    .command('init')
    .description(m.init)
    .option('--packages <names>', m.initPackages)
    .option('--target <target>', m.initTarget(TARGETS.join(' | ')))
    .option('--sources <kinds>', m.initSources(SOURCE_KINDS.join(', ')))
    .option('--channel <kind>', m.initChannel(CHANNEL_KINDS.join(' | ')))
    .option(
      '--workflow-path <path>',
      m.initWorkflowPath,
      '.github/workflows/play-review-notify.yml',
    )
    .option('-y, --yes', m.initYes)
    .option('-f, --force', m.initForce)
    .action(
      async (cmd: {
        packages?: string;
        target?: string;
        sources?: string;
        channel?: string;
        workflowPath: string;
        yes?: boolean;
        force?: boolean;
      }) => {
        const g = program.opts<GlobalOpts>();
        const run = async (io: InitIo) => {
          const opts: InitOptions = {
            configPath: g.config,
            workflowPath: cmd.workflowPath,
            cwd: process.cwd(),
            force: cmd.force ?? false,
            yes: cmd.yes ?? false,
            interactive,
            lang,
          };
          if (cmd.packages) opts.packages = parsePackageList(cmd.packages, lang);
          if (cmd.target) opts.target = parseInitChoice(cmd.target, TARGETS, 'target', lang);
          if (cmd.channel)
            opts.channel = parseInitChoice(cmd.channel, CHANNEL_KINDS, 'channel', lang);
          if (cmd.sources)
            opts.sources = cmd.sources
              .split(/[,\s]+/)
              .filter(Boolean)
              .map((x) => parseInitChoice(x, SOURCE_KINDS, 'source', lang));
          return runInit(opts, io);
        };
        const out = (t: string) => process.stderr.write(t);
        try {
          const result = interactive
            ? await withReadline((rl) =>
                run({ ask: (q, d) => rl.question(`${q}${d ? ` [${d}]` : ''}: `), out }),
              )
            : await run({ ask: async () => '', out });
          if (g.json) process.stdout.write(JSON.stringify(result) + '\n');
          process.exit(EXIT.OK);
        } catch (e) {
          process.stderr.write(m.initFailed((e as Error).message) + '\n');
          process.exit(EXIT.CONFIG);
        }
      },
    );

  program
    .command('auth')
    .argument('<provider>', m.authProvider)
    .description(m.auth(docs.gmailOauth))
    .option('--client-id <id>', m.authClientId)
    .option('--client-secret <secret>', m.authClientSecret)
    .option('--port <port>', m.authPort, (v) => Number(v))
    .option('--no-open', m.authNoOpen)
    .action(
      async (
        provider: string,
        cmd: { clientId?: string; clientSecret?: string; port?: number; open: boolean },
      ) => {
        const g = program.opts<GlobalOpts>();
        if (provider !== 'gmail') {
          process.stderr.write(m.unknownProvider(provider) + '\n');
          process.exit(EXIT.CONFIG);
        }
        const clientId = cmd.clientId ?? process.env['GMAIL_CLIENT_ID'];
        const clientSecret = cmd.clientSecret ?? process.env['GMAIL_CLIENT_SECRET'];
        if (!clientId || !clientSecret) {
          process.stderr.write(m.missingOauthClient(docs.gmailOauth) + '\n');
          process.exit(EXIT.CONFIG);
        }
        const err = (t: string) => process.stderr.write(t + '\n');
        try {
          const result = await authorizeGmail({
            clientId,
            clientSecret,
            port: cmd.port ?? 0,
            openBrowser: cmd.open,
            onAuthUrl: (url) =>
              err(`${cmd.open ? m.openingBrowser : m.visit}\n\n  ${url}\n\n${m.waitingRedirect}`),
          });
          if (g.json) {
            process.stdout.write(JSON.stringify(result) + '\n');
          } else {
            err(m.authorized(result.emailAddress));
            process.stdout.write(`GMAIL_REFRESH_TOKEN=${result.refreshToken}\n`);
            err(m.keepSecret);
          }
          process.exit(EXIT.OK);
        } catch (e) {
          err(m.authFailed((e as Error).message));
          process.exit(EXIT.CONFIG);
        }
      },
    );

  return program;
}

async function main(argv: string[]): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let lang: Lang;
  try {
    lang = await resolveLang({
      argv: argv.slice(2),
      env: process.env,
      interactive,
      gate: askLangInTerminal,
    });
  } catch (e) {
    if (!(e instanceof LangError)) throw e;
    process.stderr.write(`${e.message}\n`);
    process.exit(EXIT.CONFIG);
  }
  await buildProgram(lang, interactive).parseAsync(argv);
}

main(process.argv).catch((e: unknown) => {
  const msg = e instanceof ConfigError ? e.message : ((e as Error).stack ?? String(e));
  process.stderr.write(msg + '\n');
  process.exit(e instanceof ConfigError ? EXIT.CONFIG : EXIT.NOTIFY_FAILED);
});
