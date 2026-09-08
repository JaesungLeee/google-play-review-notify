import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../../src/core/template';
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
