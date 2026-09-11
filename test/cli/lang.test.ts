import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatLangResult, runLangCommand } from '../../src/cli/lang';
import { readPrefs } from '../../src/cli/prefs';

describe('lang command', () => {
  let dir: string;
  let prefsPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prn-lang-'));
    prefsPath = join(dir, 'preferences.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('shows the current language and its source without touching the file', () => {
    const result = runLangCommand({ current: { lang: 'en', source: 'default' }, prefsPath });
    expect(result).toEqual({ action: 'show', lang: 'en', source: 'default', path: prefsPath });
    expect(existsSync(prefsPath)).toBe(false);
    const text = formatLangResult(result, 'en');
    expect(text).toMatch(/^en \(English\): default; nothing saved yet/);
    expect(text).toContain('play-review-notify lang en|ko');

    const saved = runLangCommand({ current: { lang: 'ko', source: 'saved' }, prefsPath });
    const savedText = formatLangResult(saved, 'ko');
    expect(savedText).toBe(`ko (한국어): ${prefsPath}에 저장됨`);
    expect(savedText).not.toContain('lang en|ko');

    const overridden = runLangCommand({ current: { lang: 'en', source: 'option' }, prefsPath });
    expect(formatLangResult(overridden, 'en')).toBe('en (English): from --lang, for this run only');
  });

  it('saves a language and confirms in that language', () => {
    const result = runLangCommand({
      value: '한국어',
      current: { lang: 'en', source: 'default' },
      prefsPath,
    });
    expect(result).toEqual({ action: 'save', lang: 'ko', source: 'saved', path: prefsPath });
    expect(readPrefs(prefsPath)).toEqual({ lang: 'ko' });
    expect(formatLangResult(result, 'en')).toMatch(/^언어를 한국어\(으\)로 설정했습니다/);

    const back = runLangCommand({
      value: 'en',
      current: { lang: 'ko', source: 'saved' },
      prefsPath,
    });
    expect(readPrefs(prefsPath)).toEqual({ lang: 'en' });
    expect(formatLangResult(back, 'ko')).toMatch(/^Language set to English\. Saved in /);
  });

  it('rejects an unknown language with a bilingual message and saves nothing', () => {
    expect(() =>
      runLangCommand({ value: 'fr', current: { lang: 'en', source: 'default' }, prefsPath }),
    ).toThrow(/lang: unknown language "fr"[\s\S]*알 수 없는 언어/);
    expect(existsSync(prefsPath)).toBe(false);
  });

  it('forgets the saved language and falls back to English', () => {
    runLangCommand({ value: 'ko', current: { lang: 'en', source: 'default' }, prefsPath });
    const result = runLangCommand({
      reset: true,
      current: { lang: 'ko', source: 'saved' },
      prefsPath,
    });
    expect(result).toEqual({ action: 'reset', lang: 'en', source: 'default', path: prefsPath });
    expect(readPrefs(prefsPath)).toEqual({});
    // The confirmation is in the language the user was reading, i.e. the one just removed.
    expect(formatLangResult(result, 'ko')).toMatch(/저장된 언어를 지웠습니다/);

    // With --lang the run keeps its explicit language after the reset.
    const explicit = runLangCommand({
      reset: true,
      current: { lang: 'ko', source: 'option' },
      prefsPath,
    });
    expect(explicit).toMatchObject({ action: 'reset', lang: 'ko', source: 'option' });
  });
});
