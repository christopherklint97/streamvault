import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChannelStore } from './channelStore';
import { useRecordingStore } from './recordingStore';
import type { CommercialSegment, CommercialSegmentsResponse } from '../types';

function metadata(id: string): CommercialSegmentsResponse {
  const segment: CommercialSegment = {
    id,
    startSeconds: 10,
    endSeconds: 20,
    source: 'manual',
    confidence: 1,
    state: 'accepted',
  };
  return {
    analysis: { status: 'ready', error: null, detector: null, profileVersion: null },
    segments: [segment],
    autoSkipOverride: null,
    effectiveAutoSkip: true,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('recording commercial metadata ordering', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChannelStore.setState({ apiBaseUrl: '' });
    useRecordingStore.setState({
      recordings: [],
      commercialSegments: {},
      commercialSegmentsLoading: {},
      commercialSegmentsError: {},
    });
  });

  it('uses the PUT response directly and ignores an older GET that finishes afterward', async () => {
    let resolveOld!: (response: Response) => void;
    const oldGet = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const saved = metadata('saved');
    let getCount = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((!init?.method || init.method === 'GET') && String(url).includes('/commercial-segments')) {
        getCount += 1;
        return getCount === 1 ? oldGet : json(metadata('stale-refresh'));
      }
      if ((!init?.method || init.method === 'GET') && String(url).endsWith('/api/recordings')) {
        return json({ recordings: [] });
      }
      if (init?.method === 'PUT') return json(saved);
      throw new Error(`Unexpected request ${String(url)} ${init?.method}`);
    });

    const pendingLoad = useRecordingStore.getState().fetchCommercialSegments('r1', { force: true });
    const result = await useRecordingStore.getState().saveCommercialSegments('r1', saved.segments);

    expect(result).toEqual(saved);
    expect(fetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes('/commercial-segments') && (!init?.method || init.method === 'GET'),
    )).toHaveLength(1);
    expect(useRecordingStore.getState().commercialSegments.r1).toEqual(saved);

    resolveOld(json(metadata('stale')));
    await pendingLoad;
    expect(useRecordingStore.getState().commercialSegments.r1).toEqual(saved);
  });

  it('uses the PATCH response directly and prevents an older GET from restoring stale override data', async () => {
    let resolveOld!: (response: Response) => void;
    const oldGet = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const updated = { ...metadata('current'), autoSkipOverride: false, effectiveAutoSkip: false };
    let getCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((!init?.method || init.method === 'GET') && String(url).includes('/commercial-segments')) {
        getCount += 1;
        return getCount === 1 ? oldGet : json(metadata('stale-refresh'));
      }
      if (init?.method === 'PATCH') return json(updated);
      throw new Error(`Unexpected request ${String(url)} ${init?.method}`);
    });

    const pendingLoad = useRecordingStore.getState().fetchCommercialSegments('r1', { force: true });
    await expect(useRecordingStore.getState().setCommercialSkipOverride('r1', false)).resolves.toEqual(updated);
    resolveOld(json(metadata('stale')));
    await pendingLoad;

    expect(useRecordingStore.getState().commercialSegments.r1).toEqual(updated);
  });
});

describe('recording rule mutations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChannelStore.setState({ apiBaseUrl: '' });
    useRecordingStore.setState({ rules: [] });
  });

  it('creates a rule with matching, padding, repeat, and retention fields', async () => {
    const rule = {
      id: 'rule-1', channel_id: 'espn', channel_name: 'ESPN', match_title: 'SportsCenter',
      match_type: 'exact' as const, repeat_policy: 'new_only' as const, enabled: 1,
      padding_before: 60_000, padding_after: 180_000, max_recordings: 1, created_at: 1,
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ rule }));

    await expect(useRecordingStore.getState().createRule({
      channelId: 'espn',
      channelName: 'ESPN',
      matchTitle: 'SportsCenter',
      matchType: 'exact',
      paddingBefore: 60_000,
      paddingAfter: 180_000,
      repeatPolicy: 'new_only',
      maxRecordings: 1,
    })).resolves.toEqual(rule);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      channelId: 'espn',
      channelName: 'ESPN',
      matchTitle: 'SportsCenter',
      matchType: 'exact',
      paddingBefore: 60_000,
      paddingAfter: 180_000,
      repeatPolicy: 'new_only',
      maxRecordings: 1,
    });
    expect(useRecordingStore.getState().rules).toEqual([rule]);
  });

  it('sends repeat policy updates and consumes the returned rule', async () => {
    const initial = {
      id: 'rule-1', channel_id: 'espn', channel_name: 'ESPN', match_title: 'SportsCenter',
      match_type: 'exact' as const, repeat_policy: 'include_unknown' as const, enabled: 1,
      padding_before: 0, padding_after: 0, max_recordings: 0, created_at: 1,
    };
    const updated = { ...initial, repeat_policy: 'all' as const };
    useRecordingStore.setState({ rules: [initial] });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ rule: updated }));

    await useRecordingStore.getState().updateRule('rule-1', { repeatPolicy: 'all' });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ repeatPolicy: 'all' });
    expect(useRecordingStore.getState().rules[0]).toEqual(updated);
  });
});
