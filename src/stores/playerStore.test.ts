import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChannelStore } from './channelStore';
import { usePlayerStore } from './playerStore';

describe('player store backend switching', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChannelStore.setState({ apiBaseUrl: 'http://backend-a.test:3002', backendGeneration: 0 });
    usePlayerStore.setState({ groupChannels: [], groupChannelsLoading: false });
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
