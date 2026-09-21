import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('early logger backend URL', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('parses the JSON-encoded backend URL written by the storage helper', async () => {
    localStorage.setItem('streamvault_api_url', JSON.stringify('http://192.168.1.20:3002'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const { earlyLog } = await import('./early-log');

    earlyLog('boot');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://192.168.1.20:3002/api/client-logs',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('still supports backend URLs stored by older releases as raw strings', async () => {
    localStorage.setItem('streamvault_api_url', 'http://192.168.1.21:3002');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const { earlyLog } = await import('./early-log');

    earlyLog('boot');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://192.168.1.21:3002/api/client-logs',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
