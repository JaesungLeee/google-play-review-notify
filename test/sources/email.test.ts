import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EmailSourceAdapter } from '../../src/sources/email';
import {
  classifyEmail,
  htmlToText,
  loadBuiltinRuleSets,
  senderAllowed,
  type ParsedEmail,
} from '../../src/sources/email/rules';
import { logger, makeConfig } from '../helpers';

/** Parse the simple "Header: value\n\nbody" fixture format. */
function fixture(name: string): ParsedEmail {
  const text = readFileSync(join(__dirname, '..', 'fixtures', 'email', name), 'utf8');
  const [head = '', ...rest] = text.split('\n\n');
  const h = Object.fromEntries(head.split('\n').map((l) => l.split(/:\s(.*)/s).slice(0, 2)));
  return {
    id: name,
    from: h['From'] ?? '',
    subject: h['Subject'] ?? '',
    body: rest.join('\n\n'),
    receivedAt: '2026-09-07T09:00:00.000Z',
  };
}

describe('email rules (draft rule set)', () => {
  const sets = loadBuiltinRuleSets();

  it('loads the builtin English rule set', () => {
    expect(sets.map((s) => s.locale)).toContain('en');
  });

  it('classifies a rejection and extracts package, version code and reason', () => {
    const c = classifyEmail(fixture('rejected-sample.txt'), sets);
    expect(c.type).toBe('REJECTED');
    expect(c.packageName).toBe('com.example.app');
    expect(c.appName).toBe('Example App');
    expect(c.versionCode).toBe('1204');
    expect(c.reason).toContain('Deceptive Behavior');
  });

  it('falls back to UNKNOWN_NOTICE', () => {
    const c = classifyEmail(
      { id: '1', from: 'x', subject: 'Monthly newsletter', body: '', receivedAt: '' },
      sets,
    );
    expect(c.type).toBe('UNKNOWN_NOTICE');
  });

  it('caps reason length', () => {
    const c = classifyEmail(
      {
        id: '1',
        from: 'x',
        subject: 'has been rejected',
        body: 'Reason: ' + 'a'.repeat(50),
        receivedAt: '',
      },
      sets,
      { reasonMaxLength: 10 },
    );
    expect(c.reason).toHaveLength(10);
  });
});

describe('email rules (real-world fixtures, Phase 0)', () => {
  const sets = loadBuiltinRuleSets();

  it('bundles English and Korean rule sets', () => {
    expect(sets.map((s) => s.locale)).toEqual(['en', 'ko']);
  });

  const cases: Array<[string, Partial<ReturnType<typeof classifyEmail>>]> = [
    [
      'en/rejected-content-rating.txt',
      {
        type: 'REJECTED',
        packageName: 'com.example.sampleapp',
        appName: 'Sample App',
        reason: 'Violation of Content Ratings policy',
      },
    ],
    [
      'ko/rejected-data-safety.txt',
      {
        type: 'REJECTED',
        packageName: 'com.example.samplechat',
        appName: 'Sample Chat',
        versionCode: '1',
        reason: '데이터 보안 양식 잘못됨',
      },
    ],
    [
      'ko/rejected-login-credentials.txt',
      {
        type: 'REJECTED',
        packageName: 'com.example.sample',
        appName: '찰나 - Sample',
        versionCode: '2',
        reason: 'Play Console 요구사항 위반',
      },
    ],
    [
      // Same subject as a rejection, but the body says "상태: 추가 조치 필요" (deadline warning).
      'ko/policy-warning-account-deletion-link.txt',
      {
        type: 'POLICY_WARNING',
        packageName: 'com.example.samplealbum',
        appName: 'Sample Album',
        reason: '데이터 보안 양식의 계정/데이터 삭제 링크가 잘못됨',
      },
    ],
    ['ko/policy-warning-target-api-level.txt', { type: 'POLICY_WARNING' }],
  ];

  for (const [name, expected] of cases) {
    it(`classifies ${name}`, () => {
      const c = classifyEmail(fixture(name), sets);
      expect(c).toMatchObject(expected);
      if (!('packageName' in expected)) expect(c.packageName).toBeUndefined();
    });
  }

  for (const name of [
    'en/unrelated-brazil-statute.txt',
    'ko/unrelated-terms-of-service.txt',
    'ko/unrelated-tax-change.txt',
    'ko/unrelated-developer-verification.txt',
  ]) {
    it(`does not misclassify ${name}`, () => {
      expect(classifyEmail(fixture(name), sets).type).toBe('UNKNOWN_NOTICE');
    });
  }
});

describe('senderAllowed', () => {
  it('matches exact addresses and domain suffixes, ignoring display names', () => {
    const allow = ['googleplay-noreply@google.com', '@google.com'];
    expect(senderAllowed('Google Play <googleplay-noreply@google.com>', allow)).toBe(true);
    expect(senderAllowed('someone@google.com', allow)).toBe(true);
    expect(senderAllowed('evil@google.com.attacker.io', allow)).toBe(false);
  });
});

describe('htmlToText', () => {
  it('strips tags and decodes entities', () => {
    expect(htmlToText('<p>Hello&nbsp;<b>world</b></p><br><div>Bye &amp; more</div>')).toBe(
      'Hello world\n\nBye & more',
    );
  });
});

describe('EmailSourceAdapter', () => {
  const config = makeConfig({
    sources: {
      email: { enabled: true, auth: { clientId: 'a', clientSecret: 'b', refreshToken: 'c' } },
    },
  });
  const rejected = fixture('rejected-sample.txt');

  it('emits events, skips disallowed senders, and tracks processed ids', async () => {
    const client = {
      search: async () => [rejected, { ...rejected, id: 'spam', from: 'x@evil.io' }],
    };
    const adapter = new EmailSourceAdapter(config.sources.email, client, loadBuiltinRuleSets());
    const r = await adapter.poll(
      { logger, now: new Date('2026-09-07T10:00:00Z'), baseline: false, apps: config.apps },
      undefined,
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      id: 'email:rejected-sample.txt',
      type: 'REJECTED',
      packageName: 'com.example.app',
      source: 'email',
      confidence: 'high',
    });
    expect(r.events[0]?.consoleUrl).toContain('com.example.app');
    expect(r.nextState).toMatchObject({ watermark: '2026-09-07T09:00:00.000Z' });
    expect((r.nextState['processedMessageIds'] as string[]).sort()).toEqual([
      'rejected-sample.txt',
      'spam',
    ]);

    const again = await adapter.poll(
      { logger, now: new Date(), baseline: false, apps: config.apps },
      r.nextState,
    );
    expect(again.events).toHaveLength(0);
  });

  it('matches package by app name when the email lacks one', async () => {
    const msg: ParsedEmail = {
      ...rejected,
      id: 'noname',
      subject: 'Your app Example App has been rejected',
      body: 'Reason: nope',
    };
    const adapter = new EmailSourceAdapter(
      config.sources.email,
      { search: async () => [msg] },
      loadBuiltinRuleSets(),
    );
    const r = await adapter.poll(
      { logger, now: new Date(), baseline: false, apps: config.apps },
      undefined,
    );
    expect(r.events[0]?.packageName).toBe('com.example.app');
  });
});
