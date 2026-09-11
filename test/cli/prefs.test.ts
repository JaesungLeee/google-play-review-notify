import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prefsFilePath, readPrefs, writePrefs } from '../../src/cli/prefs';

describe('prefsFilePath', () => {
  it('follows XDG_CONFIG_HOME, then ~/.config, and APPDATA on Windows', () => {
    expect(prefsFilePath({ XDG_CONFIG_HOME: '/xdg' }, 'darwin', '/home/u')).toBe(
      join('/xdg', 'play-review-notify', 'preferences.json'),
    );
    expect(prefsFilePath({ XDG_CONFIG_HOME: '' }, 'linux', '/home/u')).toBe(
      join('/home/u', '.config', 'play-review-notify', 'preferences.json'),
    );
    expect(prefsFilePath({ APPDATA: '/appdata', XDG_CONFIG_HOME: '/xdg' }, 'win32', '/u')).toBe(
      join('/appdata', 'play-review-notify', 'preferences.json'),
    );
    // APPDATA is only honored on Windows; without it Windows falls back like everyone else.
    expect(prefsFilePath({ APPDATA: '/appdata' }, 'linux', '/home/u')).toBe(
      join('/home/u', '.config', 'play-review-notify', 'preferences.json'),
    );
    expect(prefsFilePath({}, 'win32', '/u')).toBe(
      join('/u', '.config', 'play-review-notify', 'preferences.json'),
    );
  });
});

describe('readPrefs / writePrefs', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prn-prefs-'));
    path = join(dir, 'nested', 'preferences.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('treats a missing, malformed, or unrecognized file as empty', () => {
    expect(readPrefs(path)).toEqual({});
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(readPrefs(join(dir, 'bad.json'))).toEqual({});
    writeFileSync(join(dir, 'array.json'), '[1]');
    expect(readPrefs(join(dir, 'array.json'))).toEqual({});
    writeFileSync(join(dir, 'unknown.json'), JSON.stringify({ lang: 'fr' }));
    expect(readPrefs(join(dir, 'unknown.json'))).toEqual({});
  });

  it('round-trips the language, creating the directory', () => {
    writePrefs(path, { lang: 'ko' });
    expect(readPrefs(path)).toEqual({ lang: 'ko' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ lang: 'ko' });
  });

  it('keeps unknown keys and removes a key set to undefined', () => {
    writeFileSync(path.replace('nested/', ''), '');
    writePrefs(path, { lang: 'en' });
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...raw, future: true }));
    writePrefs(path, { lang: 'ko' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ lang: 'ko', future: true });
    writePrefs(path, { lang: undefined });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ future: true });
    expect(readPrefs(path)).toEqual({});
  });
});
