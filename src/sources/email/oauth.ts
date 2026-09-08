/**
 * One-time Gmail OAuth2 authorization used by `play-review-notify auth gmail`.
 *
 * Runs the "loopback" flow recommended for installed apps: a temporary HTTP server on
 * 127.0.0.1 receives the authorization code, which is exchanged for a refresh token with
 * the minimal `gmail.readonly` scope. Requires an OAuth client of type "Desktop app".
 */
import { auth as googleAuth, gmail as gmailApi } from '@googleapis/gmail';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const CALLBACK_PATH = '/oauth2callback';

export interface AuthorizeGmailOptions {
  clientId: string;
  clientSecret: string;
  /** Local callback port; 0 (default) picks a free one. */
  port?: number;
  /** Set false to only print the URL (headless machines). */
  openBrowser?: boolean;
  /** Called with the consent URL so the caller can display it. */
  onAuthUrl?: (url: string) => void;
  /** Give up after this long without a callback. Default 5 minutes. */
  timeoutMs?: number;
}

export interface AuthorizeGmailResult {
  refreshToken: string;
  /** Gmail address of the authorized account, when the profile lookup succeeds. */
  emailAddress?: string;
}

/** Injection points for tests. */
export interface AuthorizeGmailDeps {
  exchange?: (code: string, redirectUri: string) => Promise<AuthorizeGmailResult>;
  open?: (url: string) => void;
}

export async function authorizeGmail(
  opts: AuthorizeGmailOptions,
  deps: AuthorizeGmailDeps = {},
): Promise<AuthorizeGmailResult> {
  const exchange =
    deps.exchange ?? ((code, uri) => exchangeCode(opts.clientId, opts.clientSecret, code, uri));
  const open = deps.open ?? openInBrowser;
  const state = randomBytes(16).toString('hex');

  const { port, waitForCode, close } = await startCallbackServer(opts.port ?? 0, state);
  try {
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const url = new googleAuth.OAuth2(
      opts.clientId,
      opts.clientSecret,
      redirectUri,
    ).generateAuthUrl({
      access_type: 'offline',
      // Force the consent screen so Google always returns a refresh token, even when the
      // account already authorized this client before.
      prompt: 'consent',
      scope: [GMAIL_READONLY_SCOPE],
      state,
    });
    opts.onAuthUrl?.(url);
    if (opts.openBrowser !== false) open(url);

    const code = await waitForCode(opts.timeoutMs ?? 5 * 60_000);
    return await exchange(code, redirectUri);
  } finally {
    await close();
  }
}

async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<AuthorizeGmailResult> {
  const oauth2 = new googleAuth.OAuth2(clientId, clientSecret, redirectUri);
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Remove this app from ' +
        'https://myaccount.google.com/permissions and run the command again.',
    );
  }
  const result: AuthorizeGmailResult = { refreshToken: tokens.refresh_token };
  try {
    oauth2.setCredentials(tokens);
    const profile = await gmailApi({ version: 'v1', auth: oauth2 }).users.getProfile({
      userId: 'me',
    });
    if (profile.data.emailAddress) result.emailAddress = profile.data.emailAddress;
  } catch {
    // Profile lookup is informational only.
  }
  return result;
}

interface CallbackServer {
  port: number;
  waitForCode(timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

/** Starts the loopback server; resolves once it is listening. Exported for tests. */
export async function startCallbackServer(
  port: number,
  expectedState: string,
): Promise<CallbackServer> {
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (err: Error) => void = () => {};
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The rejection is observed through waitForCode(); this keeps Node from flagging it as unhandled
  // when the callback arrives before (or without) a waiter.
  codePromise.catch(() => {});

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end('Not found');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page(false, error));
      rejectCode(new Error(`Authorization failed: ${error}`));
      return;
    }
    const code = url.searchParams.get('code');
    if (url.searchParams.get('state') !== expectedState || !code) {
      // Wrong state: ignore the request but keep waiting for the genuine callback.
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Invalid state');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(true));
    resolveCode(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const actualPort = (server.address() as AddressInfo).port;

  return {
    port: actualPort,
    waitForCode(timeoutMs) {
      const timeout = new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for the browser`)),
          timeoutMs,
        ).unref(),
      );
      return Promise.race([codePromise, timeout]);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function page(ok: boolean, detail = ''): string {
  const title = ok ? 'Authorization complete' : 'Authorization failed';
  const body = ok
    ? 'You can close this window and return to the terminal.'
    : `Google returned: <code>${escapeHtml(detail)}</code>. Return to the terminal and try again.`;
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3rem"><h1>${title}</h1><p>${body}</p></body>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {
    // The URL is printed anyway; failing to open a browser is not fatal.
  }
}
