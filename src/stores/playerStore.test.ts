import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChannelStore } from './channelStore';
import { usePlayerStore } from './playerStore';

describe('player store backend switching', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChannelStore.setState({ apiBaseUrl: 'http://backend-a.test:3002', backendGeneration: 0 });
    usePlayerStore.setState({ groupChannels: [], groupChannelsLoading: false });
  });

  it('loads group channels through bounded browse pages rather than heavy channel metadata', async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      requests.push(url);
      if (!url.includes('/api/browse?') || !url.includes('limit=200')) throw new Error(`Unexpected URL: ${url}`);
      const second = url.includes('after=');
      return new Response(JSON.stringify({
        channels: [{ id: second ? 'live_2' : 'live_1', group: 'Sports', contentType: 'livetv' }],
        nextCursor: second ? null : '{"s":1,"n":"First"}',
      }), { status: 200 });
    });

    await usePlayerStore.getState().fetchGroupChannels('Sports');
    expect(requests).toHaveLength(2);
    expect(usePlayerStore.getState().groupChannels.map(channel => channel.id)).toEqual(['live_1', 'live_2']);
  });

  it('ignores a stale group response after switching to another group', async () => {
    let releaseOld!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('group=Old')) return new Promise<Response>(resolve => { releaseOld = resolve; });
      return new Response(JSON.stringify({ channels: [{ id: 'live_new', group: 'New' }], nextCursor: null }), { status: 200 });
    });
    const oldRequest = usePlayerStore.getState().fetchGroupChannels('Old');
    await Promise.resolve();
    await usePlayerStore.getState().fetchGroupChannels('New');
    releaseOld(new Response(JSON.stringify({ channels: [{ id: 'live_old', group: 'Old' }], nextCursor: null }), { status: 200 }));
    await oldRequest;
    expect(usePlayerStore.getState().groupChannels.map(channel => channel.id)).toEqual(['live_new']);
  });

  it('does not replace cached group A when a pending group B finishes after selecting A again', async () => {
    let release!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const cached = { id: 'live_a', name: 'A', group: 'A', url: '', logo: '', region: '', contentType: 'livetv' as const };
    usePlayerStore.setState({ groupChannels: [cached] });
    const pending = usePlayerStore.getState().fetchGroupChannels('B');
    usePlayerStore.getState().setChannel(cached);
    release(new Response(JSON.stringify({ channels: [{ ...cached, id: 'live_b', group: 'B' }] }), { status: 200 }));
    await pending;
    expect(usePlayerStore.getState().groupChannels.map(channel => channel.id)).toEqual(['live_a']);
    expect(usePlayerStore.getState().groupChannelsLoading).toBe(false);
  });

  it('aborts replaced group reads rather than leaving catalog traffic behind playback', async () => {
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_input, options) => {
      signal = options?.signal;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError'))));
    }).mockResolvedValue(new Response(JSON.stringify({ channels: [], nextCursor: null }), { status: 200 }));
    const old = usePlayerStore.getState().fetchGroupChannels('Old');
    await usePlayerStore.getState().fetchGroupChannels('New');
    expect(signal?.aborted).toBe(true);
    await old;
  });

  it('does not let an old backend failure clear the new backend loading state', async () => {
    let rejectOld!: (reason: unknown) => void;
    const pendingNew = new Promise<Response>(() => undefined);
    vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(new Promise<Response>((_resolve, reject) => { rejectOld = reject; }))
      .mockReturnValueOnce(pendingNew);

    const oldRequest = usePlayerStore.getState().fetchGroupChannels('Old');
    await Promise.resolve();
    useChannelStore.setState({ apiBaseUrl: 'http://backend-b.test:3002', backendGeneration: 1 });
    void usePlayerStore.getState().fetchGroupChannels('New');
    await Promise.resolve();
    expect(usePlayerStore.getState().groupChannelsLoading).toBe(true);

    rejectOld(new TypeError('Failed to fetch'));
    await oldRequest;

    expect(usePlayerStore.getState().groupChannelsLoading).toBe(true);
  });
});
