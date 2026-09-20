import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommercialSegmentsResponse, Recording } from '../types';
import { useAppStore } from '../stores/appStore';
import { useRecordingStore } from '../stores/recordingStore';
import RecordingDetail from './RecordingDetail';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const recording: Recording = {
  id: 'recording-1', channel_id: 'channel-1', channel_name: 'News', title: 'Evening News',
  status: 'completed', start_time: 1, end_time: 2, actual_start: 1, actual_end: 2,
  file_path: '/recordings/news.ts', file_size: 1, duration: 120, error: null,
  rule_id: null, program_title: 'Evening News', created_at: 1,
};

function metadata(id: string): CommercialSegmentsResponse {
  return {
    analysis: { status: 'ready', error: null, detector: 'test', profileVersion: '1' },
    segments: [{
      id, startSeconds: 10, endSeconds: 20, source: 'manual', confidence: 1, state: 'accepted',
    }],
    autoSkipOverride: null,
    effectiveAutoSkip: true,
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

describe('RecordingDetail draft integration', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resolveMetadata!: (value: CommercialSegmentsResponse | null) => void;
  const fetchCommercialSegments = vi.fn(() => new Promise<CommercialSegmentsResponse | null>((resolve) => {
    resolveMetadata = resolve;
  }));

  beforeEach(async () => {
    vi.clearAllMocks();
    useRecordingStore.setState({
      recordings: [recording],
      commercialSegments: { 'recording-1': metadata('cached') },
      commercialSegmentsLoading: {},
      commercialSegmentsError: {},
      fetchRecordings: vi.fn(async () => {}),
      fetchCommercialSegments,
      analyzeCommercials: vi.fn(async () => true),
      saveCommercialSegments: vi.fn(async () => null),
      setCommercialSkipOverride: vi.fn(async () => null),
    });
    useAppStore.setState({
      currentView: 'recordingDetail',
      viewStack: ['recordings'],
      selectedRecordingId: 'recording-1',
      navigationBlocker: null,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<RecordingDetail recordingId="recording-1" />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps cached intervals and every editor mutation disabled until the forced metadata load succeeds', async () => {
    expect(fetchCommercialSegments).toHaveBeenCalledWith('recording-1', { force: true });
    expect(button(container, '+ Add interval').disabled).toBe(true);
    expect(button(container, 'On').disabled).toBe(true);
    expect(container.querySelector('[data-segment-id="cached"]')).toBeNull();

    await act(async () => {
      resolveMetadata(metadata('fresh'));
      await Promise.resolve();
    });

    expect(button(container, '+ Add interval').disabled).toBe(false);
    expect(button(container, 'On').disabled).toBe(false);
    expect(container.querySelector('[data-segment-id="fresh"]')).not.toBeNull();
  });

  it('registers the central blocker after an edit so all navigation paths share confirmation', async () => {
    await act(async () => {
      resolveMetadata(metadata('fresh'));
      await Promise.resolve();
    });

    const start = container.querySelector('#fresh-startSeconds') as HTMLInputElement;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(start, '11');
      start.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).toContain('Unsaved changes');
    expect(useAppStore.getState().navigationBlocker).toEqual(expect.any(Function));

    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    expect(useAppStore.getState().handlePopNavigation()).toBe(false);
    expect(useAppStore.getState().currentView).toBe('recordingDetail');
    expect(confirm).toHaveBeenCalledWith('Discard unsaved commercial interval changes?');

    confirm.mockReturnValue(true);
    expect(useAppStore.getState().goBack()).toBe(true);
    expect(useAppStore.getState().currentView).toBe('recordings');
  });
});
