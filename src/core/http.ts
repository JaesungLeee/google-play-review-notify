/** fetch with retry: exponential backoff, honors Retry-After on 429. */
export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await doFetch(url, init);
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      lastError = new HttpError(res.status, body);
      if (!retryable || attempt === retries) throw lastError;
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : base * 2 ** attempt;
      await sleep(delay);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastError = e as Error;
      if (attempt === retries) throw lastError;
      await sleep(base * 2 ** attempt);
    }
  }
  throw lastError ?? new Error('fetchWithRetry: unreachable');
}
