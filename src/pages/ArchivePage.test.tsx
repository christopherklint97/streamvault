import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArchivePage from './ArchivePage';

const { fetchArchives, setArchive, getPlayback, setChannel, navigate } = vi.hoisted(() => ({
  fetchArchives: vi.fn(), setArchive: vi.fn(), getPlayback: vi.fn(), setChannel: vi.fn(), navigate: vi.fn(),
}));
vi.mock('../services/archivePlayback', () => ({
  getArchiveChannels: fetchArchives, setArchiveChannel: setArchive, getArchivePlayback: getPlayback,
}));
vi.mock('../stores/channelStore', () => ({ useChannelStore: (select: (s: object) => unknown) => select({ apiBaseUrl: '' }) }));
vi.mock('../stores/playerStore', () => ({ usePlayerStore: (select: (s: object) => unknown) => select({ setChannel }) }));
vi.mock('../stores/appStore', () => ({ useAppStore: (select: (s: object) => unknown) => select({ navigate, showToastMessage: vi.fn() }) }));

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  fetchArchives.mockResolvedValue([{ channelId: 'live_7', channelName: 'ESPN', enabled: true,
    retentionHours: 24, availableFrom: 1000, availableTo: 2000, diskUsageBytes: 1000 }]);
  getPlayback.mockResolvedValue({ url: '/api/archive/snapshots/s1/index.m3u8?ticket=x', duration: 1, startTime: 1000, endTime: 2000 });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('archive playback', () => {
  it('plays a finite 24h snapshot as DVR HLS rather than live TV', async () => {
    await act(async () => { root.render(<ArchivePage />); });
    await vi.waitFor(() => expect(container.textContent).toContain('Watch archive'));
    const button = [...container.querySelectorAll('button')].find(item => item.textContent?.includes('Watch archive'));
    expect(button).toBeDefined();
    await act(async () => { button?.click(); });
    expect(getPlayback).toHaveBeenCalledWith({ apiBaseUrl: '', channelId: 'live_7', startTime: 1000, endTime: 2000 });
    expect(setChannel).toHaveBeenCalledWith(expect.objectContaining({ dvrHls: true, contentType: 'movies',
      url: '/api/archive/snapshots/s1/index.m3u8?ticket=x' }));
    expect(navigate).toHaveBeenCalledWith('player');
  });
});
