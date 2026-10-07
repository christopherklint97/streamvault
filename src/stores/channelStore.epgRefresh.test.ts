import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChannelStore } from './channelStore';

beforeEach(() => {
  vi.useFakeTimers();
  useChannelStore.setState({ apiBaseUrl: '', backendGeneration: 0, error: null });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('obsolete EPG completion', () => {
  it.each(['success', 'failure'])('does not rearm global refresh after obsolete %s', async outcome => {
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((done, fail) => { resolve = done; reject = fail; }));
    const old = useChannelStore.getState().fetchPrograms();
    useChannelStore.setState({ backendGeneration: 1 });
    if (outcome === 'success') resolve(new Response('{"programs":[]}'));
    else reject(new Error('Old backend failed'));
    await old;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not replace the current backend refresh timer with an obsolete one', async () => {
    let resolveOld!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(new Promise<Response>(resolve => { resolveOld = resolve; }))
      .mockImplementation(async () => new Response('{"programs":[]}'));
    const old = useChannelStore.getState().fetchPrograms();
    useChannelStore.setState({ backendGeneration: 1 });
    await useChannelStore.getState().fetchPrograms();
    await vi.advanceTimersByTimeAsync(1000);
    resolveOld(new Response('{"programs":[]}'));
    await old;
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
