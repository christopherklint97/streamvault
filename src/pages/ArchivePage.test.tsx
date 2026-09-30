import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArchivePage from './ArchivePage';

const { fetchArchives, setArchive, getPlayback, setChannel, navigate, fetchPrograms } = vi.hoisted(() => ({
  fetchArchives: vi.fn(), setArchive: vi.fn(), getPlayback: vi.fn(), setChannel: vi.fn(), navigate: vi.fn(), fetchPrograms: vi.fn(),
}));
vi.mock('../services/api', () => ({ apiFetch: fetchPrograms }));
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
  getPlayback.mockResolvedValue({ url: '/api/archive/snapshots/s1/index.m3u8?ticket=x', duration: 1,
    startTime: 1000, endTime: 2000, startOffsetSeconds: 0.2, gaps: [] });
  fetchPrograms.mockResolvedValue({ programs: [] });
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
    expect(setChannel).toHaveBeenCalledWith(expect.objectContaining({ dvrHls: true, initialSeekSeconds: 0.2, contentType: 'movies',
      url: '/api/archive/snapshots/s1/index.m3u8?ticket=x' }));
    expect(navigate).toHaveBeenCalledWith('player');
  });
  it('clamps a boundary segment to 24 hours for playback and guide queries', async () => {
    const end = 1_000 + 24 * 3_600_000 + 20_000;
    fetchArchives.mockResolvedValue([{ channelId: 'live_7', channelName: 'ESPN', enabled: true,
      retentionHours: 24, availableFrom: 1_000, availableTo: end, diskUsageBytes: 1000 }]);
    await act(async () => { root.render(<ArchivePage />); });
    await vi.waitFor(() => expect(container.textContent).toContain('Watch archive'));
    const button = [...container.querySelectorAll('button')].find(item => item.textContent?.includes('Watch archive'));
    await act(async () => { button?.click(); });
    expect(getPlayback).toHaveBeenCalledWith({ apiBaseUrl: '', channelId: 'live_7',
      startTime: 21_000, endTime: end });
    expect(fetchPrograms).toHaveBeenCalledWith('',
      `/api/archives/live_7/programs?from=21000&to=${end}`);
  });
  it('does not silently reset a configured weekly retention when paused', async () => {
    fetchArchives.mockResolvedValue([{ channelId: 'live_7', channelName: 'ESPN', enabled: true,
      retentionHours: 168, availableFrom: 1_000, availableTo: 2_000, diskUsageBytes: 1000 }]);
    setArchive.mockResolvedValue({});
    await act(async () => { root.render(<ArchivePage />); });
    await vi.waitFor(() => expect(container.textContent).toContain('Stop archiving'));
    const button = [...container.querySelectorAll('button')].find(item => item.textContent?.includes('Stop archiving'));
    await act(async () => { button?.click(); });
    expect(setArchive).toHaveBeenCalledWith('', 'live_7', { channelName: 'ESPN', enabled: false, retentionHours: 168 });
  });
});
