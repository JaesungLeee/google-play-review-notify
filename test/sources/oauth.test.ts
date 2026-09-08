import { describe, expect, it, vi } from 'vitest';
import {
  GMAIL_READONLY_SCOPE,
  authorizeGmail,
  startCallbackServer,
} from '../../src/sources/email/oauth';

const CLIENT = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh' };

/** Extracts the state and redirect_uri Google would echo back from the consent URL. */
function parseAuthUrl(url: string) {
  const u = new URL(url);
  return {
    state: u.searchParams.get('state')!,
    redirectUri: u.searchParams.get('redirect_uri')!,
    scope: u.searchParams.get('scope'),
    prompt: u.searchParams.get('prompt'),
    accessType: u.searchParams.get('access_type'),
    clientId: u.searchParams.get('client_id'),
  };
}

describe('authorizeGmail', () => {
  it('opens the consent URL, receives the loopback callback, and exchanges the code', async () => {
    const open = vi.fn();
    const exchange = vi.fn(async (code: string, redirectUri: string) => ({
      refreshToken: `rt-for-${code}`,
      emailAddress: `dev@example.com via ${redirectUri}`,
    }));
    let authUrl = '';

    const pending = authorizeGmail(
      { ...CLIENT, onAuthUrl: (u) => (authUrl = u), timeoutMs: 5_000 },
      { open, exchange },
    );
    await vi.waitFor(() => expect(authUrl).not.toBe(''));

    const parsed = parseAuthUrl(authUrl);
    expect(parsed.clientId).toBe(CLIENT.clientId);
    expect(parsed.scope).toBe(GMAIL_READONLY_SCOPE);
    expect(parsed.prompt).toBe('consent');
    expect(parsed.accessType).toBe('offline');
    expect(parsed.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
    expect(open).toHaveBeenCalledWith(authUrl);

    // A request with the wrong state is rejected but does not end the flow.
    const bad = await fetch(`${parsed.redirectUri}?code=evil&state=nope`);
    expect(bad.status).toBe(400);
    await bad.text();
    // Unknown paths (e.g. favicon) are ignored too.
    const missing = await fetch(parsed.redirectUri.replace('/oauth2callback', '/favicon.ico'));
    expect(missing.status).toBe(404);
    await missing.text();

    const good = await fetch(`${parsed.redirectUri}?code=abc123&state=${parsed.state}`);
    expect(good.status).toBe(200);
    expect(await good.text()).toContain('Authorization complete');

    await expect(pending).resolves.toEqual({
      refreshToken: 'rt-for-abc123',
      emailAddress: `dev@example.com via ${parsed.redirectUri}`,
    });
    expect(exchange).toHaveBeenCalledWith('abc123', parsed.redirectUri);

    // Server is closed afterwards.
    await expect(fetch(parsed.redirectUri)).rejects.toThrow();
  });

  it('does not open a browser when openBrowser is false', async () => {
    const open = vi.fn();
    let authUrl = '';
    const pending = authorizeGmail(
      { ...CLIENT, openBrowser: false, onAuthUrl: (u) => (authUrl = u), timeoutMs: 5_000 },
      { open, exchange: async () => ({ refreshToken: 'x' }) },
    );
    await vi.waitFor(() => expect(authUrl).not.toBe(''));
    expect(open).not.toHaveBeenCalled();
    const { redirectUri, state } = parseAuthUrl(authUrl);
    await (await fetch(`${redirectUri}?code=c&state=${state}`)).text();
    await expect(pending).resolves.toEqual({ refreshToken: 'x' });
  });

  it('fails when Google reports an error', async () => {
    let authUrl = '';
    const pending = authorizeGmail(
      { ...CLIENT, openBrowser: false, onAuthUrl: (u) => (authUrl = u), timeoutMs: 5_000 },
      { exchange: async () => ({ refreshToken: 'never' }) },
    );
    // Register the expectation first: the flow may reject before the response body is read.
    const failure = expect(pending).rejects.toThrow('access_denied');
    await vi.waitFor(() => expect(authUrl).not.toBe(''));
    const { redirectUri } = parseAuthUrl(authUrl);
    const res = await fetch(`${redirectUri}?error=access_denied`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('access_denied');
    await failure;
  });

  it('times out when the browser never calls back', async () => {
    await expect(
      authorizeGmail(
        { ...CLIENT, openBrowser: false, timeoutMs: 50 },
        { exchange: async () => ({ refreshToken: 'never' }) },
      ),
    ).rejects.toThrow('Timed out');
  });
});

describe('startCallbackServer', () => {
  it('binds to the requested port on 127.0.0.1 only', async () => {
    const s = await startCallbackServer(0, 'st');
    expect(s.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${s.port}/oauth2callback?code=1&state=st`);
    expect(res.status).toBe(200);
    await res.text();
    await expect(s.waitForCode(1_000)).resolves.toBe('1');
    await s.close();
  });
});
