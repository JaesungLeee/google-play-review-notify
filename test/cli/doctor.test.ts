import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatDoctorReport, runDoctor } from '../../src/cli/doctor';
import type { GmailClient } from '../../src/sources/email/gmail';
import type { PlayApiClient } from '../../src/sources/play-api/client';
import { makeConfig } from '../helpers';

const byId = (results: Awaited<ReturnType<typeof runDoctor>>) =>
  Object.fromEntries(results.map((r) => [r.id, r]));

const gmailOk: GmailClient = {
  profile: async () => ({ emailAddress: 'dev@example.com' }),
  search: async () => [
    { id: '1', from: 'x', subject: 'Action Required', body: '', receivedAt: '' },
  ],
};
const playOk: PlayApiClient = {
  listReleases: async (_pkg, track) =>
    track === 'production' ? [{ name: '1.0.0', state: 'IN_REVIEW', versionCodes: ['3'] }] : [],
};

describe('runDoctor', () => {
  it('reports ok for a healthy configuration', async () => {
    const config = makeConfig({
      sources: {
        email: { enabled: true, auth: { clientId: 'a', clientSecret: 'b', refreshToken: 'c' } },
        playApi: { enabled: true, serviceAccountJson: '{}' },
      },
      stateStore: {
        type: 'file',
        path: join(tmpdir(), 'play-review-notify-doctor-test', 'state.json'),
      },
    });
    const r = byId(
      await runDoctor(config, {
        gmailClient: () => gmailOk,
        playClient: () => playOk,
        env: {},
      }),
    );
    expect(r['gmail.auth']).toMatchObject({
      status: 'ok',
      message: 'Authorized as dev@example.com',
    });
    expect(r['gmail.inbox']?.status).toBe('ok');
    expect(r['play-api.com.example.app']).toMatchObject({ status: 'ok' });
    expect(r['play-api.com.example.app']?.message).toContain('production=[1.0.0:IN_REVIEW(3)]');
    expect(r['channels.slack']?.status).toBe('ok');
    expect(r['state']?.status).toBe('ok');
    expect(Object.values(r).some((x) => x.status === 'fail')).toBe(false);
  });

  it('explains an expired Gmail token and a pending Play Console permission', async () => {
    const config = makeConfig({
      sources: {
        email: { enabled: true, auth: { clientId: 'a', clientSecret: 'b', refreshToken: 'c' } },
        playApi: { enabled: true, serviceAccountJson: '{}' },
      },
    });
    const r = byId(
      await runDoctor(config, {
        gmailClient: () => ({
          profile: async () => {
            throw new Error('invalid_grant: Token has been expired or revoked.');
          },
          search: async () => [],
        }),
        playClient: () => ({
          listReleases: async () => {
            throw new Error('403: The caller does not have permission');
          },
        }),
        env: {},
      }),
    );
    expect(r['gmail.auth']?.status).toBe('fail');
    expect(r['gmail.auth']?.hint).toContain('auth gmail');
    expect(r['play-api.com.example.app']?.status).toBe('fail');
    expect(r['play-api.com.example.app']?.hint).toContain('Users and permissions');
  });

  it('warns per track that cannot be listed, and about quiet inboxes and odd URLs', async () => {
    const config = makeConfig({
      apps: [{ packageName: 'com.example.app', tracks: ['production', 'internal'] }],
      sources: {
        email: { enabled: true, auth: { clientId: 'a', clientSecret: 'b', refreshToken: 'c' } },
        playApi: { enabled: true, serviceAccountJson: '{}' },
      },
      channels: { slack: { type: 'slack', webhookUrl: 'https://example.com/not-slack' } },
      stateStore: { type: 'github-cache' },
    });
    const r = byId(
      await runDoctor(config, {
        gmailClient: () => ({ ...gmailOk, search: async () => [] }),
        playClient: () => ({
          listReleases: async (_pkg, track) => {
            if (track === 'internal') throw new Error('404: track not found');
            return [{ name: '1.0.0', state: 'PUBLISHED', versionCodes: ['3'] }];
          },
        }),
        env: {},
      }),
    );
    expect(r['gmail.inbox']?.status).toBe('warn');
    expect(r['play-api.com.example.app']).toMatchObject({ status: 'warn' });
    expect(r['play-api.com.example.app']?.message).toContain('production=[1.0.0:PUBLISHED(3)]');
    expect(r['play-api.com.example.app']?.hint).toContain('internal');
    expect(r['channels.slack']?.status).toBe('warn');
    expect(r['state']).toMatchObject({ status: 'warn' }); // github-cache outside Actions
    expect(r['config.rejections']).toBeUndefined();
    expect(r['config.releases']).toBeUndefined();
  });

  it('fails when no source is enabled and warns about undetectable events', async () => {
    const config = makeConfig({
      apps: [{ packageName: 'com.example.app', channels: [] }],
      defaultChannels: [],
      sources: { email: { enabled: false } },
    });
    const r = byId(await runDoctor(config, { env: {} }));
    expect(r['config.sources']?.status).toBe('fail');
    expect(r['config.releases']?.status).toBe('warn');
    expect(r['config.routing']?.status).toBe('warn');
    expect(r['config.rejections']?.status).toBe('warn');
    expect(r['gmail']?.status).toBe('skip');
  });
});

describe('formatDoctorReport', () => {
  it('prints one line per check with hints and a summary', () => {
    const text = formatDoctorReport([
      { id: 'node', status: 'ok', message: 'Node.js 20' },
      { id: 'gmail.auth', status: 'fail', message: 'boom', hint: 'do this' },
      { id: 'state', status: 'warn', message: 'hmm', hint: 'or that' },
    ]);
    expect(text).toContain('✔ node: Node.js 20');
    expect(text).toContain('✖ gmail.auth: boom\n    → do this');
    expect(text).toContain('⚠ state: hmm');
    expect(text.trim().endsWith('1 problem(s), 1 warning(s)')).toBe(true);
  });
});
