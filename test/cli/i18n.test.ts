import { describe, expect, it, vi } from 'vitest';
import { collectAnswers, runInit, type InitIo } from '../../src/cli/init';
import { formatDoctorReport, runDoctor } from '../../src/cli/doctor';
import {
  langFromArgv,
  langFromEnv,
  MESSAGES,
  parseLang,
  promptLang,
  resolveLang,
  systemLang,
  type Lang,
} from '../../src/cli/i18n';
import { makeConfig } from '../helpers';

/** Every dotted key path of a message table, with the value's type. */
function shape(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [`${prefix}=${typeof obj}`];
  return Object.entries(obj).flatMap(([k, v]) => shape(v, prefix ? `${prefix}.${k}` : k));
}

function gateIo(answers: string[]) {
  const queue = [...answers];
  const io = {
    output: [] as string[],
    prompts: [] as string[],
    ask: async (p: string) => {
      io.prompts.push(p);
      return queue.shift() ?? '';
    },
    out: (t: string) => {
      io.output.push(t);
    },
  };
  return io;
}

describe('message tables', () => {
  it('have identical shapes in every language', () => {
    expect(shape(MESSAGES.ko).sort()).toEqual(shape(MESSAGES.en).sort());
  });

  it('point Korean readers at the translated docs', () => {
    expect(MESSAGES.ko.docs.gmailOauth).toBe('gmail-oauth.ko.md');
    expect(MESSAGES.en.docs.gmailOauth).toBe('gmail-oauth.md');
  });
});

describe('parseLang', () => {
  it('accepts option values, menu numbers, and common spellings', () => {
    for (const v of ['en', 'EN', '1', 'english', '영어']) expect(parseLang(v)).toBe('en');
    for (const v of ['ko', 'kr', '2', 'korean', '한국어', ' 한글 '])
      expect(parseLang(v)).toBe('ko');
    expect(parseLang('fr')).toBeUndefined();
    expect(parseLang('')).toBeUndefined();
  });
});

describe('langFromArgv / langFromEnv', () => {
  it('reads --lang anywhere before "--" in both spellings', () => {
    expect(langFromArgv(['init', '--lang', 'ko'])).toBe('ko');
    expect(langFromArgv(['--lang=en', 'doctor'])).toBe('en');
    expect(langFromArgv(['doctor'])).toBeUndefined();
    expect(langFromArgv(['emit', '--', '--lang', 'ko'])).toBeUndefined();
  });

  it('rejects unknown values with a bilingual message', () => {
    expect(() => langFromArgv(['--lang', 'fr'])).toThrow(
      /unknown language "fr"[\s\S]*알 수 없는 언어/,
    );
    expect(() => langFromArgv(['--lang'])).toThrow(/--lang/);
    expect(() => langFromEnv({ PLAY_REVIEW_NOTIFY_LANG: 'jp' })).toThrow(
      /PLAY_REVIEW_NOTIFY_LANG: unknown language "jp"/,
    );
    expect(langFromEnv({ PLAY_REVIEW_NOTIFY_LANG: '' })).toBeUndefined();
    expect(langFromEnv({ PLAY_REVIEW_NOTIFY_LANG: 'ko' })).toBe('ko');
  });
});

describe('systemLang', () => {
  it('defaults the gate to Korean on a Korean locale, English otherwise', () => {
    expect(systemLang({ LANG: 'ko_KR.UTF-8' })).toBe('ko');
    expect(systemLang({ LC_ALL: 'ko' })).toBe('ko');
    expect(systemLang({ LANG: 'en_US.UTF-8' })).toBe('en');
    expect(systemLang({})).toBe('en');
    // "kok" (Konkani) must not match.
    expect(systemLang({ LANG: 'kok_IN' })).toBe('en');
  });
});

describe('promptLang (the gate)', () => {
  it('shows both languages, applies the default on Enter, and re-asks on garbage', async () => {
    const io = gateIo(['x', '']);
    expect(await promptLang(io, 'ko')).toBe('ko');
    expect(io.output[0]).toMatch(/Language \/ 언어/);
    expect(io.output[0]).toMatch(/1\) English/);
    expect(io.output[0]).toMatch(/2\) 한국어/);
    expect(io.prompts[0]).toMatch(/\[2\]/);
    expect(io.output.join('')).toMatch(/1 또는 2/);
    expect(io.prompts).toHaveLength(2);
  });

  it('accepts a number or a name', async () => {
    expect(await promptLang(gateIo(['2']), 'en')).toBe('ko');
    expect(await promptLang(gateIo(['English']), 'ko')).toBe('en');
  });
});

describe('resolveLang', () => {
  const gate = () => vi.fn<(d: Lang) => Promise<Lang>>().mockResolvedValue('ko');

  it('prefers --lang, then the environment, then the gate, then English', async () => {
    const g = gate();
    expect(
      await resolveLang({
        argv: ['--lang', 'en'],
        env: { PLAY_REVIEW_NOTIFY_LANG: 'ko' },
        interactive: true,
        gate: g,
      }),
    ).toBe('en');
    expect(
      await resolveLang({
        argv: ['doctor'],
        env: { PLAY_REVIEW_NOTIFY_LANG: 'ko' },
        interactive: true,
        gate: g,
      }),
    ).toBe('ko');
    expect(g).not.toHaveBeenCalled();

    expect(await resolveLang({ argv: ['doctor'], env: {}, interactive: true, gate: g })).toBe('ko');
    expect(g).toHaveBeenCalledWith('en');
  });

  it('passes the system locale to the gate as its default', async () => {
    const g = gate();
    await resolveLang({ argv: [], env: { LANG: 'ko_KR.UTF-8' }, interactive: true, gate: g });
    expect(g).toHaveBeenCalledWith('ko');
  });

  it('never asks outside a terminal or when the output is for machines', async () => {
    const g = gate();
    expect(await resolveLang({ argv: ['run'], env: {}, interactive: false, gate: g })).toBe('en');
    expect(
      await resolveLang({ argv: ['run', '--json'], env: {}, interactive: true, gate: g }),
    ).toBe('en');
    expect(await resolveLang({ argv: ['--version'], env: {}, interactive: true, gate: g })).toBe(
      'en',
    );
    expect(await resolveLang({ argv: ['-V'], env: {}, interactive: true, gate: g })).toBe('en');
    expect(g).not.toHaveBeenCalled();
  });
});

describe('Korean output', () => {
  const io = (): InitIo & { questions: string[]; output: string[] } => {
    const o = {
      questions: [] as string[],
      output: [] as string[],
      ask: async (q: string) => {
        o.questions.push(q);
        return '';
      },
      out: (t: string) => {
        o.output.push(t);
      },
    };
    return o;
  };

  it('asks the init questions and reports errors in Korean', async () => {
    const i = io();
    const opts = {
      configPath: 'x.yml',
      workflowPath: 'wf.yml',
      cwd: '/nonexistent',
      force: false,
      yes: false,
      interactive: true,
      lang: 'ko' as const,
    };
    await expect(collectAnswers({ ...opts, packages: ['com.a.app'] }, i)).resolves.toMatchObject({
      channel: 'slack',
    });
    expect(i.questions[0]).toBe('Play Console에 표시되는 com.a.app의 앱 이름');
    expect(i.questions.some((q) => q.includes('알림 채널'))).toBe(true);

    await expect(collectAnswers({ ...opts, interactive: false }, i)).rejects.toThrow(
      /패키지 이름이 없습니다/,
    );
    await expect(
      collectAnswers({ ...opts, yes: true, packages: ['com.a.app'], sources: [] }, i),
    ).rejects.toThrow(/소스를 하나 이상/);
  });

  it('prints Korean next steps that link the translated docs', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const cwd = mkdtempSync(join(tmpdir(), 'prn-i18n-'));
    try {
      const i = io();
      await runInit(
        {
          configPath: 'play-review-notify.yml',
          workflowPath: '.github/workflows/play-review-notify.yml',
          cwd,
          force: false,
          yes: true,
          interactive: false,
          packages: ['com.a.app'],
          lang: 'ko',
        },
        i,
      );
      const text = i.output.join('');
      expect(text).toContain('다음 단계:');
      expect(text).toContain('docs/gmail-oauth.ko.md');
      expect(text).toContain('# GMAIL_REFRESH_TOKEN을 출력');
      expect(text).not.toMatch(/Next steps/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('localizes doctor messages, hints, and the summary but keeps check ids stable', async () => {
    const config = makeConfig({ sources: { email: { enabled: false } } });
    const results = await runDoctor(config, { lang: 'ko', env: {} });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId['gmail']?.message).toBe('이메일 소스 비활성화됨');
    expect(byId['config.rejections']?.hint).toContain('docs/gmail-oauth.ko.md');
    expect(byId['state']?.message).toContain('상태 저장소 없음');
    const report = formatDoctorReport(results, 'ko');
    expect(report).toMatch(/(문제 \d+건, 경고 \d+건|모두 정상, 경고 \d+건)$/);
    expect(formatDoctorReport([], 'en')).toContain('All good');
  });
});
