import { describe, expect, it } from 'vitest';
import { ConfigError, interpolateEnv, parseConfig } from '../../src/core/config';

describe('config', () => {
  it('applies defaults for events, sources and state store', () => {
    const c = parseConfig({ apps: [{ packageName: 'a.b.c' }] });
    expect(c.events.APPROVED.enabled).toBe(true);
    expect(c.events.REJECTED.reasonFollowUp).toBe(true);
    expect(c.events.SUBMITTED.enabled).toBe(false);
    expect(c.events.PENDING_SUBMISSION.enabled).toBe(false);
    expect(c.sources.email.enabled).toBe(false);
    expect(c.sources.email.lookbackHours).toBe(24);
    expect(c.stateStore).toEqual({ type: 'file', path: '.play-review-notify/state.json' });
    expect(c.apps[0]?.tracks).toEqual(['production']);
  });

  it('ignores keys from 0.3 configs with a warning instead of failing', () => {
    const warnings: string[] = [];
    const c = parseConfig(
      {
        apps: [{ packageName: 'a.b.c' }],
        sources: {
          playApi: { enabled: false, emitLiveWithoutConfirmation: true },
          storeListing: { enabled: true, locale: 'ko' },
        },
        events: { UNKNOWN_NOTICE: { enabled: true }, REMOVED: { enabled: false } },
      },
      {},
      { onWarning: (w) => warnings.push(w) },
    );
    expect(Object.keys(c.events)).not.toContain('UNKNOWN_NOTICE');
    expect(Object.keys(c.sources)).toEqual(['email', 'playApi']);
    expect(warnings).toEqual([
      'events.REMOVED is no longer supported and was ignored (removed in 0.4)',
      'events.UNKNOWN_NOTICE is no longer supported and was ignored (removed in 0.4)',
      'sources.storeListing is no longer supported and was ignored (removed in 0.4)',
      'sources.playApi.emitLiveWithoutConfirmation is no longer supported and was ignored (removed in 0.4)',
    ]);
  });

  it('interpolates ${ENV} references and fails on missing ones', () => {
    expect(interpolateEnv({ a: 'x-${FOO}-y', b: ['${FOO}'] }, { FOO: '1' })).toEqual({
      a: 'x-1-y',
      b: ['1'],
    });
    expect(() => interpolateEnv('${MISSING}', {})).toThrow(ConfigError);
  });

  it('rejects unknown channel references', () => {
    expect(() =>
      parseConfig({ apps: [{ packageName: 'a.b.c', channels: ['nope'] }], channels: {} }),
    ).toThrow(/unknown channel "nope"/);
  });

  it('validates channel shapes by type', () => {
    expect(() =>
      parseConfig({ apps: [{ packageName: 'a.b.c' }], channels: { s: { type: 'slack' } } }),
    ).toThrow(ConfigError);
    const c = parseConfig({
      apps: [{ packageName: 'a.b.c' }],
      channels: { w: { type: 'webhook', url: 'https://n8n.example/hook', secret: 's' } },
    });
    expect(c.channels['w']).toMatchObject({ type: 'webhook', batch: false, headers: {} });
  });
});
