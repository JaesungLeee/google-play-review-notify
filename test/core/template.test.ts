import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../../src/core/template';
import type { ReviewEvent } from '../../src/core/types';
import { renderMessage } from '../../src/templates';
import { makeConfig, makeEvent } from '../helpers';

describe('renderTemplate', () => {
  it('substitutes dotted paths and blanks missing values', () => {
    expect(renderTemplate('{{a}} {{b.c}} [{{missing}}]', { a: 1, b: { c: 'x' } })).toBe('1 x []');
  });
  it('handles sections and inverted sections', () => {
    const t = '{{#reason}}R: {{reason}}{{/reason}}{{^reason}}no reason{{/reason}}';
    expect(renderTemplate(t, { reason: 'bad' })).toBe('R: bad');
    expect(renderTemplate(t, {})).toBe('no reason');
  });
});

describe('renderMessage in Korean', () => {
  const event: ReviewEvent = {
    id: 'e1',
    type: 'REJECTED',
    packageName: 'com.example.app',
    track: 'production',
    versionName: '3.4.2',
    versionCode: '1204',
    reason: '정책 위반',
    consoleUrl: 'https://play.google.com/console',
    source: 'email',
    confidence: 'high',
    observedAt: '2026-09-11T00:00:00.000Z',
  };

  it('uses Korean titles, body, and field labels when language is ko', () => {
    const config = makeConfig({ language: 'ko' });
    const m = renderMessage(config, { ...event, followUp: true }, config.apps[0]);
    expect(m.title).toBe('🚫 거절됨 — Example App (com.example.app) (사유 추가됨)');
    expect(m.body).toContain('트랙: production · 버전: 3.4.2 (1204)');
    expect(m.body).toContain('사유: 정책 위반');
    expect(m.body).toContain('Play Console에서 열기 → https://play.google.com/console');
    expect(m.body).toMatch(/출처: email · 2026-09-11/);
    expect(m.fields.map((f) => f.label)).toEqual(['패키지', '트랙', '버전', '출처']);
    expect(renderMessage(config, { ...event, packageName: undefined } as ReviewEvent).title).toBe(
      '🚫 거절됨 — 알 수 없는 앱',
    );
  });

  it('keeps user templates as written and defaults to English', () => {
    const ko = makeConfig({ language: 'ko', templates: { REJECTED: 'custom {{reason}}' } });
    const m = renderMessage(ko, event, ko.apps[0]);
    expect(m.title).toContain('거절됨');
    expect(m.body).toBe('custom 정책 위반');
    expect(makeConfig().language).toBe('en');
    expect(renderMessage(makeConfig(), event).title).toContain('Rejected');
  });
});

describe('renderMessage', () => {
  it('renders default title/body with reason and console link', () => {
    const config = makeConfig();
    const m = renderMessage(config, makeEvent({ consoleUrl: 'https://console' }), config.apps[0]);
    expect(m.title).toContain('Rejected — Example App (com.example.app)');
    expect(m.body).toContain('Track: production · Version: 3.4.2 (1204)');
    expect(m.body).toContain('Reason: Policy violation');
    expect(m.body).toContain('https://console');
    expect(m.color).toBe('d73a49');
  });
  it('omits reason when includeReason is false and applies template overrides', () => {
    const config = makeConfig({
      includeReason: false,
      templates: { REJECTED: 'X {{packageName}} {{reason}}' },
    });
    const m = renderMessage(config, makeEvent());
    expect(m.body).toBe('X com.example.app');
  });
  it('uses mentions from event config', () => {
    const config = makeConfig({
      events: { REJECTED: { enabled: true, mentions: ['<!channel>'] } },
    });
    expect(renderMessage(config, makeEvent()).mentions).toEqual(['<!channel>']);
  });
});
