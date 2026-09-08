import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, HttpError } from '../../src/core/http';

const res = (status: number, headers: Record<string, string> = {}) =>
  new Response('x', { status, headers });

describe('fetchWithRetry', () => {
  it('retries on 5xx and 429 honoring Retry-After', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(500))
      .mockResolvedValueOnce(res(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(res(200));
    const sleep = vi.fn(async () => undefined);
    const r = await fetchWithRetry('https://x', {}, { fetchImpl, sleep, baseDelayMs: 100 });
    expect(r.status).toBe(200);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 2000]);
  });

  it('does not retry on 4xx other than 429', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(res(400));
    await expect(
      fetchWithRetry('https://x', {}, { fetchImpl, sleep: async () => undefined }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after retries', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(res(503));
    await expect(
      fetchWithRetry('https://x', {}, { fetchImpl, sleep: async () => undefined, retries: 2 }),
    ).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
