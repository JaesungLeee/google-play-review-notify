import type { Logger } from './types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  json?: boolean;
  /** Strings that must never appear in output (secrets). */
  redact?: string[];
}

export function createConsoleLogger(opts: ConsoleLoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const redact = (opts.redact ?? []).filter((s) => s.length > 0);

  const scrub = (text: string): string =>
    redact.reduce((acc, secret) => acc.split(secret).join('***'), text);

  const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = opts.json
      ? JSON.stringify({ level: lvl, msg, ...meta, ts: new Date().toISOString() })
      : `[${lvl.toUpperCase()}] ${msg}${meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}`;
    const out = scrub(line);
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(out + '\n');
    else process.stdout.write(out + '\n');
  };

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
