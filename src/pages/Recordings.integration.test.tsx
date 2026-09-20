import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Recording } from '../types';
import { useAppStore } from '../stores/appStore';
import { useChannelStore } from '../stores/channelStore';
import { usePlayerStore } from '../stores/playerStore';
import { useRecordingStore } from '../stores/recordingStore';

const { getRecordingPlaybackUrlMock } = vi.hoisted(() => ({
  getRecordingPlaybackUrlMock: vi.fn(),
}));

vi.mock('../services/recordingPlayback', () => ({
  getRecordingPlaybackUrl: getRecordingPlaybackUrlMock,
}));

import Recordings from './Recordings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const completedRecording: Recording = {
  id: 'recording-1',
  channel_id: 'channel-1',
  channel_name: 'News',
  title: 'Evening News',
  status: 'completed',
  start_time: 1,
  end_time: 2,
  actual_start: 1,
  actual_end: 2,
  file_path: '/recordings/evening-news.ts',
  file_size: 1024,
  duration: 1800,
  error: null,
  rule_id: null,
  program_title: 'Evening News',
  created_at: 1,
};

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

describe('Recordings integration', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchRecordings = vi.fn(async () => {});
  const fetchRules = vi.fn(async () => {});
  const fetchStatus = vi.fn(async () => {});
  const setChannel = vi.fn();
  const navigate = vi.fn(() => true);
  const showToastMessage = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    useRecordingStore.setState({
      recordings: [completedRecording],
      rules: [],
      status: null,
      fetchRecordings,
      fetchRules,
      fetchStatus,
    });
    useChannelStore.setState({ apiBaseUrl: 'https://dvr.example.test' });
    usePlayerStore.setState({ setChannel });
    useAppStore.setState({ navigate, showToastMessage });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Recordings />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('waits for a playback ticket before setting the recording channel and navigating', async () => {
    let resolveTicket!: (url: string) => void;
    getRecordingPlaybackUrlMock.mockReturnValue(new Promise<string>((resolve) => {
      resolveTicket = resolve;
    }));

    await act(async () => {
      findButton(container, 'Play').click();
    });

    expect(getRecordingPlaybackUrlMock).toHaveBeenCalledWith({
      apiBaseUrl: 'https://dvr.example.test',
      recordingId: 'recording-1',
      directUrl: '/api/recordings/recording-1/stream',
    });
    expect(setChannel).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      resolveTicket('https://dvr.example.test/api/recordings/recording-1/play?ticket=one-time');
      await Promise.resolve();
    });

    expect(setChannel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'recording_recording-1',
      recordingId: 'recording-1',
      url: 'https://dvr.example.test/api/recordings/recording-1/play?ticket=one-time',
    }));
    expect(navigate).toHaveBeenCalledWith('player');
  });

  it('shows an error and does not navigate when ticket creation fails', async () => {
    getRecordingPlaybackUrlMock.mockRejectedValue(new Error('ticket unavailable'));

    await act(async () => {
      findButton(container, 'Play').click();
      await Promise.resolve();
    });

    expect(setChannel).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(showToastMessage).toHaveBeenCalledWith('Unable to play recording: ticket unavailable');
  });

  it('creates a recurring rule from searchable channels with explicit matching, repeat, padding, and record-once fields', async () => {
    vi.useFakeTimers();
    const createdRule = {
      id: 'rule-1', channel_id: 'espn', channel_name: 'ESPN', match_title: 'SportsCenter',
      match_type: 'startsWith' as const, repeat_policy: 'new_only' as const, enabled: 1,
      padding_before: 180_000, padding_after: 420_000, max_recordings: 1, created_at: 1,
    };
    const createRule = vi.fn(async () => createdRule);
    await act(async () => {
      useRecordingStore.setState({
        recordings: [],
        rules: [{ ...createdRule, id: 'existing' }],
        createRule,
      });
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      channels: [{
        id: 'espn', name: 'ESPN', url: '/stream', logo: '', group: 'Sports', region: '', contentType: 'livetv',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await act(async () => {
      findButton(container, 'Rules (1)').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('New only');

    const channelSearch = container.querySelector('#rule-channel-search') as HTMLInputElement;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(channelSearch, 'ES');
      channelSearch.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      findButton(container, 'ESPNSports').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const title = container.querySelector('#rule-match-title') as HTMLInputElement;
    expect(document.activeElement).toBe(title);
    const setInput = (element: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      setInput(title, 'SportsCenter');
      const match = container.querySelector('#rule-match-type') as HTMLSelectElement;
      match.value = 'startsWith';
      match.dispatchEvent(new Event('change', { bubbles: true }));
      const repeat = container.querySelector('#rule-repeat-policy') as HTMLSelectElement;
      repeat.value = 'new_only';
      repeat.dispatchEvent(new Event('change', { bubbles: true }));
      setInput(container.querySelector('#rule-padding-before') as HTMLInputElement, '3');
      setInput(container.querySelector('#rule-padding-after') as HTMLInputElement, '7');
      setInput(container.querySelector('#rule-max-recordings') as HTMLInputElement, '4');
      (container.querySelector('#rule-record-once') as HTMLInputElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      findButton(container, 'Create rule').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createRule).toHaveBeenCalledWith({
      channelId: 'espn',
      channelName: 'ESPN',
      matchTitle: 'SportsCenter',
      matchType: 'startsWith',
      paddingBefore: 180_000,
      paddingAfter: 420_000,
      repeatPolicy: 'new_only',
      maxRecordings: 1,
    });
  });
});
