/**
 * Per-user CLI preferences, kept outside the project so they are never committed or shared.
 *
 * Location: `%APPDATA%\play-review-notify\preferences.json` on Windows, otherwise
 * `$XDG_CONFIG_HOME/play-review-notify/preferences.json` (default `~/.config/...`). The file is
 * optional: a missing, unreadable, or malformed file behaves as if it were empty, so cron jobs and
 * CI never fail because of it. Unknown keys are preserved on write.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseLang, type Lang } from './i18n';

export const PREFS_DIR = 'play-review-notify';
export const PREFS_FILE = 'preferences.json';

export interface Prefs {
  /** Output language used by every command unless `--lang` or the environment overrides it. */
  lang?: Lang;
}

/** A partial update; `undefined` removes the key. */
export type PrefsPatch = { [K in keyof Prefs]?: Prefs[K] | undefined };

export function prefsFilePath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const appData = env['APPDATA'];
  const base =
    platform === 'win32' && appData ? appData : env['XDG_CONFIG_HOME'] || join(home, '.config');
  return join(base, PREFS_DIR, PREFS_FILE);
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Never throws: anything unreadable or unrecognized is treated as unset. */
export function readPrefs(path: string): Prefs {
  const raw = readJsonObject(path);
  const prefs: Prefs = {};
  const lang = typeof raw?.['lang'] === 'string' ? parseLang(raw['lang']) : undefined;
  if (lang) prefs.lang = lang;
  return prefs;
}

/** Merges `patch` into the file (creating it and its directory). Throws on I/O errors. */
export function writePrefs(path: string, patch: PrefsPatch): void {
  const next = { ...readJsonObject(path) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
}
