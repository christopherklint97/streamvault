import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api';

describe('apiFetch', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('adds the stored API token as a header without putting it in the URL', async () => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('top-secret'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await apiFetch('https://streamvault.test', '/api/recordings');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://streamvault.test/api/recordings');
    expect(String(url)).not.toContain('top-secret');
    expect(new Headers(init?.headers).get('x-streamvault-token')).toBe('top-secret');
  });

  it('supports legacy raw stored tokens and preserves an explicit caller token', async () => {
    localStorage.setItem('streamvault_auth_token', 'legacy-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await apiFetch('', '/api/config');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-streamvault-token')).toBe('legacy-token');

    await apiFetch('', '/api/config', { headers: { 'x-streamvault-token': 'request-token' } });
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('x-streamvault-token')).toBe('request-token');
  });

  it('preserves caller headers and accepts an empty successful response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));

    await expect(apiFetch('', '/api/recordings/r1/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })).resolves.toBeUndefined();
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Content-Type')).toBe('application/json');
  });
});
