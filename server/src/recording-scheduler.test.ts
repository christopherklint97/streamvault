// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DBProgram, DBRecording, DBRecordingRule } from './db.js';

const state = vi.hoisted(() => ({
  rules: [] as DBRecordingRule[],
  programs: [] as DBProgram[],
  recordings: [] as DBRecording[],
  inserted: [] as DBRecording[],
  updates: [] as Array<{ id: string; updates: Partial<DBRecording> }>,
  programQueries: [] as unknown[][],
  lifecycleCalls: [] as string[],
  ruleUpdates: [] as Array<{ id: string; updates: Partial<DBRecordingRule> }>,
  quotaGb: 50,
  usageBytes: 0,
  activeViewers: new Set<string>(),
  deletedIds: [] as string[],
  cacheRemoved: [] as string[],
}));

vi.mock('./db.js', () => ({
  getEnabledRecordingRules: () => state.rules.filter(rule => rule.enabled === 1),
  getProgramsByChannel: (...args: unknown[]) => { state.programQueries.push(args); return state.programs; },
  getRecordedContentKeysByRuleId: (ruleId: string) => new Set(
    state.recordings
      .filter(recording => recording.rule_id === ruleId && recording.content_key && !['cancelled', 'failed'].includes(recording.status))
      .map(recording => recording.content_key!),
  ),
  getRecordingByAiringKey: (key: string) => state.recordings.find(recording => recording.airing_key === key && recording.status !== 'cancelled'),
  getUpcomingRecordings: () => [],
  getRecordingsByRuleId: (ruleId: string) => state.recordings.filter(recording => recording.rule_id === ruleId),
  getRecordingRule: (ruleId: string) => state.rules.find(rule => rule.id === ruleId),
  updateRecordingRuleCadenceProjection: (id: string, revision: number, updates: Partial<DBRecordingRule>) => {
    const current = state.rules.find(rule => rule.id === id && rule.rule_revision === revision);
    if (!current) return false;
    state.ruleUpdates.push({ id, updates });
    Object.assign(current, updates);
    return true;
  },
  markRecordingRuleCadenceRetry: (id: string | null, revision: number | null, start: number | null, key: string | null) => {
    const current = state.rules.find(rule => rule.id === id && rule.rule_revision === revision);
    if (!current || start === null) return false;
    current.cadence_retry_start = start;
    current.cadence_retry_key = key;
    return true;
  },
  advanceRecordingRuleCadence: (id: string, revision: number, start: number, key: string | null) => {
    const current = state.rules.find(rule => rule.id === id && rule.rule_revision === revision);
    if (!current) return false;
    current.cadence_last_success_start = start;
    current.cadence_last_success_key = key;
    current.cadence_occurrence_progress = 0;
    current.cadence_cursor_start = start;
    current.cadence_cursor_key = key;
    current.cadence_retry_start = null;
    current.cadence_retry_key = null;
    return true;
  },
  insertRecordingForAiring: (recording: DBRecording) => {
    const existing = state.recordings.find(item => item.airing_key === recording.airing_key && item.status !== 'cancelled');
    if (existing) return existing;
    state.recordings.push(recording);
    state.inserted.push(recording);
    return recording;
  },
  updateRecording: (id: string, updates: Partial<DBRecording>) => {
    state.updates.push({ id, updates });
    const existing = state.recordings.find(recording => recording.id === id);
    if (existing) Object.assign(existing, updates);
  },
  getRecordingsByStatus: (status: string) => state.recordings.filter(recording => recording.status === status),
  getRecordings: (filter: { status?: string }) => state.recordings.filter(item => item.status === filter.status),
  deleteRecording: (id: string) => { state.deletedIds.push(id); state.recordings = state.recordings.filter(item => item.id !== id); },
  getConfig: (key: string, fallback = '') => key === 'recording_max_disk_gb' ? String(state.quotaGb) : key === 'recording_retention_days' ? '0' : fallback,
  saveProgramsForChannels: vi.fn(),
}));

vi.mock('./recorder.js', () => ({
  startRecording: vi.fn(async (id: string) => { state.lifecycleCalls.push(`start:${id}`); }),
  stopRecording: vi.fn(async (id: string) => { state.lifecycleCalls.push(`stop:${id}`); }),
  getActiveCount: () => 0,
  getRecordingsDiskUsageAsync: async () => state.usageBytes,
  getRecordingMasterFilePath: (id: string) => state.recordings.find(item => item.id === id)?.master_file_path ? `${id}.ts` : null,
  deleteRecordingFile: vi.fn(async () => { state.usageBytes -= 1_073_741_824; return 1_073_741_824; }),
  enforceAllRuleRetentions: vi.fn(async () => {}),
}));

vi.mock('./xtream.js', () => ({ fetchXtreamShortEpg: vi.fn() }));
vi.mock('./rule-epg-refresh.js', () => ({ refreshRuleChannelPrograms: vi.fn() }));
vi.mock('./recording-vod-hls.js', () => ({
  getRecordingVodHlsState: async () => 'ready',
  removeAbandonedRecordingVodStaging: async () => {},
  removeRecordingVodHlsCache: async (master: string) => { state.cacheRemoved.push(master); state.usageBytes -= 268_435_456; },
}));
vi.mock('./recording-vod-routes.js', () => ({ hasActiveRecordingVodViewer: (id: string) => state.activeViewers.has(id) }));

function rule(overrides: Partial<DBRecordingRule> = {}): DBRecordingRule {
  return {
    id: 'rule-1', channel_id: 'c1', channel_name: 'Channel', match_title: 'Show',
    match_type: 'exact', enabled: 1, padding_before: 0, padding_after: 0,
    max_recordings: 0, retention_count: 0, airing_policy: 'every', repeat_policy: 'include_unknown', created_at: 1,
    cadence_mode: 'every', cadence_interval: 1, daily_start_minutes: 0,
    schedule_timezone: 'UTC', rule_revision: 1, cadence_last_success_start: null,
    cadence_last_success_key: null,
    cadence_occurrence_progress: 0, cadence_cursor_start: null, cadence_cursor_key: null,
    cadence_retry_start: null, cadence_retry_key: null,
    ...overrides,
  };
}

function program(overrides: Partial<DBProgram> = {}): DBProgram {
  return {
    channel_id: 'c1', title: 'Show', description: '', start_time: 2_000, stop_time: 3_000,
    category: '', source: 'xtream', airing_key: 'airing-new', content_key: null, is_repeat: null,
    ...overrides,
  };
}

function recording(overrides: Partial<DBRecording> = {}): DBRecording {
  return {
    id: 'existing', channel_id: 'c1', channel_name: 'Channel', title: 'Show', status: 'completed',
    start_time: 1, end_time: 2, actual_start: 1, actual_end: 2, file_path: 'r.mp4', file_size: 1,
    duration: 1, error: null, rule_id: 'rule-1', program_title: 'Show', created_at: 1,
    airing_key: 'old', content_key: 'seen-content', ...overrides,
  };
}

beforeEach(() => {
  vi.setSystemTime(1_000);
  state.rules = [rule()];
  state.programs = [];
  state.recordings = [];
  state.inserted = [];
  state.updates = [];
  state.programQueries = [];
  state.lifecycleCalls = [];
  state.ruleUpdates = [];
  state.quotaGb = 50;
  state.usageBytes = 0;
  state.activeViewers.clear();
  state.deletedIds = [];
  state.cacheRemoved = [];
});

describe('recording disk cleanup', () => {
  it('never deletes a completed recording with an active VOD viewer under disk pressure', async () => {
    state.quotaGb = 1;
    state.usageBytes = 3 * 1_073_741_824;
    state.activeViewers.add('watching');
    state.recordings = [
      recording({ id: 'watching', actual_end: 1, master_file_path: 'watching.ts' }),
      recording({ id: 'other', actual_end: 2, master_file_path: 'other.ts' }),
    ];
    const { runCleanup } = await import('./recording-scheduler.js');
    await runCleanup();
    expect(state.cacheRemoved).toEqual(['other.ts']);
    expect(state.deletedIds).toEqual(['other']);
    expect(state.recordings.some(rec => rec.id === 'watching')).toBe(true);
  });
});

describe('recording scheduler rule integration', () => {
  it('stops expired captures before attempting to start due jobs', async () => {
    state.rules = [];
    state.recordings = [
      recording({ id: 'due', status: 'scheduled', start_time: 500, end_time: 5_000, rule_id: null }),
      recording({ id: 'expired', status: 'recording', start_time: 100, end_time: 900 }),
    ];
    const scheduler = await import('./recording-scheduler.js');

    scheduler.startScheduler();
    await scheduler.stopScheduler();

    expect(state.lifecycleCalls).toEqual(['stop:expired', 'start:due']);
  });

  it('does not start a stale-revision due row when its airing is absent from the guide', async () => {
    state.rules = [rule({ rule_revision: 2 })];
    state.programs = [];
    state.recordings = [recording({
      id: 'stale-due', status: 'scheduled', start_time: 500, end_time: 5_000,
      rule_revision: 1, airing_key: 'rolled-out', program_start_time: 500,
    })];
    const scheduler = await import('./recording-scheduler.js');

    scheduler.startScheduler();
    await scheduler.stopScheduler();

    expect(state.lifecycleCalls).not.toContain('start:stale-due');
    expect(state.recordings[0].status).toBe('scheduled');
  });

  it('schedules trustworthy first-run metadata for a new-only rule', async () => {
    state.rules = [rule({ repeat_policy: 'new_only' })];
    state.programs = [program({ airing_key: 'first-run', is_repeat: null, is_new: 1 })];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.inserted.map(item => item.airing_key)).toEqual(['first-run']);
  });

  it('preserves legacy every-airing behavior by scheduling the complete future horizon', async () => {
    state.programs = [
      program({ airing_key: 'a1', start_time: 2_000, stop_time: 3_000 }),
      program({ airing_key: 'a2', start_time: 4_000, stop_time: 5_000 }),
    ];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.inserted.map(item => item.airing_key)).toEqual(['a1', 'a2']);
    expect(state.inserted.every(item => item.cadence_slot == null)).toBe(true);
  });

  it('does not let a failed recording suppress a later successful content attempt', async () => {
    state.recordings = [recording({ status: 'failed', airing_key: 'failed-airing', content_key: 'episode-1' })];
    state.programs = [program({ airing_key: 'retry-airing', content_key: 'episode-1', is_repeat: 0 })];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.inserted.map(item => item.airing_key)).toEqual(['retry-airing']);
  });

  it('keeps scheduling a rolling rule after its retained recording count is full', async () => {
    state.rules = [rule({ retention_count: 1 })];
    state.recordings = [recording({ airing_key: 'old-airing', content_key: 'old-episode' })];
    state.programs = [program({ airing_key: 'new-airing', content_key: 'new-episode' })];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.inserted.map(item => item.airing_key)).toEqual(['new-airing']);
  });

  it('schedules only the first eligible airing for a record-once rule', async () => {
    state.rules = [rule({ airing_policy: 'once' })];
    state.programs = [
      program({ airing_key: 'first', start_time: 2_000, stop_time: 3_000 }),
      program({ airing_key: 'second', start_time: 4_000, stop_time: 5_000 }),
    ];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.inserted.map(item => item.airing_key)).toEqual(['first']);
  });

  it('allows a record-once rule to retry after a failed attempt', async () => {
    state.rules = [rule({ airing_policy: 'once' })];
    state.recordings = [recording({ status: 'failed', airing_key: 'failed' })];
    state.programs = [program({ airing_key: 'retry' })];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.inserted.map(item => item.airing_key)).toEqual(['retry']);
  });

  it('keeps one outstanding reservation and schedules every Nth occurrence after success', async () => {
    state.rules = [rule({ cadence_mode: 'occurrence', cadence_interval: 3, cadence_last_success_start: 10_000 })];
    state.programs = [2, 3, 4, 5, 6, 7].map(value => program({
      airing_key: `a${value}`, start_time: value * 10_000, stop_time: value * 10_000 + 5_000,
    }));
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.inserted.map(item => item.airing_key)).toEqual(['a4']);
    expect(state.inserted[0]?.cadence_slot).toBe(1);
  });

  it('carries occurrence progress into the next guide window', async () => {
    state.rules = [rule({
      cadence_mode: 'occurrence', cadence_interval: 5, cadence_last_success_start: 10_000,
      cadence_cursor_start: 10_000, cadence_cursor_key: 'a1',
    })];
    state.programs = [2, 3, 4].map(value => program({
      airing_key: `a${value}`, start_time: value * 10_000, stop_time: value * 10_000 + 5_000,
    }));
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();
    expect(state.inserted).toEqual([]);
    expect(state.rules[0].cadence_occurrence_progress).toBe(3);
    expect(state.rules[0].cadence_cursor_key).toBe('a4');

    state.programs = [5, 6, 7].map(value => program({
      airing_key: `a${value}`, start_time: value * 10_000, stop_time: value * 10_000 + 5_000,
    }));
    matchRules();
    expect(state.inserted.map(item => item.airing_key)).toEqual(['a6']);
  });

  it('adopts a still-selected scheduled airing into the current rule revision', async () => {
    state.rules = [rule({ rule_revision: 2, cadence_mode: 'hours', cadence_interval: 6 })];
    state.recordings = [recording({
      id: 'pending', status: 'scheduled', airing_key: 'same', rule_revision: 1, cadence_slot: null,
      start_time: 20_000, end_time: 25_000, content_key: null,
    })];
    state.programs = [program({ airing_key: 'same', start_time: 20_000, stop_time: 25_000 })];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.updates).toContainEqual({
      id: 'pending', updates: expect.objectContaining({ rule_revision: 2, cadence_slot: 1 }),
    });
  });

  it('keeps every-airing retries past the persisted terminal cursor', async () => {
    state.rules = [rule({
      cadence_mode: 'every', cadence_retry_start: 10_000, cadence_retry_key: 'a1',
    })];
    state.programs = [1, 2, 3].map(value => program({
      airing_key: `a${value}`, start_time: value * 10_000, stop_time: value * 10_000 + 5_000,
    }));
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.inserted.map(item => item.airing_key)).toEqual(['a2', 'a3']);
  });

  it('preserves earlier every-airing reservations when a later airing is terminal', async () => {
    state.rules = [rule({
      cadence_mode: 'every', cadence_retry_start: 30_000, cadence_retry_key: 'a3',
    })];
    state.programs = [1, 2, 3, 4].map(value => program({
      airing_key: `a${value}`, start_time: value * 10_000, stop_time: value * 10_000 + 5_000,
    }));
    state.recordings = [
      recording({ id: 'scheduled-a1', status: 'scheduled', airing_key: 'a1', program_start_time: 10_000, start_time: 10_000 }),
      recording({ id: 'scheduled-a2', status: 'scheduled', airing_key: 'a2', program_start_time: 20_000, start_time: 20_000 }),
      recording({ id: 'cancelled-a3', status: 'cancelled', airing_key: 'a3', program_start_time: 30_000, start_time: 30_000 }),
    ];
    const { reconcileRecordingRule } = await import('./recording-scheduler.js');

    reconcileRecordingRule('rule-1');

    expect(state.recordings.find(item => item.id === 'scheduled-a1')?.status).toBe('scheduled');
    expect(state.recordings.find(item => item.id === 'scheduled-a2')?.status).toBe('scheduled');
    expect(state.inserted.map(item => item.airing_key)).toEqual(['a4']);
  });

  it('uses durable success and retry state for record-once rules after row deletion', async () => {
    const { matchRules } = await import('./recording-scheduler.js');
    state.programs = [1, 2].map(value => program({
      airing_key: `a${value}`, start_time: value * 10_000, stop_time: value * 10_000 + 5_000,
    }));
    state.rules = [rule({ airing_policy: 'once', cadence_last_success_start: 5_000 })];

    matchRules();
    expect(state.inserted).toEqual([]);

    state.rules = [rule({
      airing_policy: 'once', cadence_retry_start: 10_000, cadence_retry_key: 'a1',
    })];
    state.recordings = [recording({
      id: 'failed-a1', status: 'failed', airing_key: 'a1',
      program_start_time: 10_000, start_time: 10_000,
    })];
    matchRules();
    expect(state.inserted.map(item => item.airing_key)).toEqual(['a2']);
  });

  it('replaces an obsolete pending airing without letting it consume the lifetime cap', async () => {
    state.rules = [rule({ max_recordings: 1 })];
    state.recordings = [recording({ id: 'obsolete', status: 'scheduled', airing_key: 'old' })];
    state.programs = [
      program({ airing_key: 'old', title: 'Other', start_time: 10_000, stop_time: 15_000 }),
      program({ airing_key: 'new', start_time: 20_000, stop_time: 25_000 }),
    ];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.updates).toContainEqual({
      id: 'obsolete', updates: expect.objectContaining({ status: 'cancelled' }),
    });
    expect(state.inserted.map(item => item.airing_key)).toEqual(['new']);
  });

  it('sweeps deleted, disabled, and stale-revision due rows before startup', async () => {
    state.rules = [
      rule({ id: 'disabled-rule', enabled: 0 }),
      rule({ id: 'edited-rule', rule_revision: 2 }),
    ];
    state.recordings = [
      recording({ id: 'deleted', status: 'scheduled', rule_id: 'deleted-rule', start_time: 500 }),
      recording({ id: 'disabled', status: 'scheduled', rule_id: 'disabled-rule', start_time: 500 }),
      recording({
        id: 'stale', status: 'scheduled', rule_id: 'edited-rule', rule_revision: 1, airing_key: 'current',
        start_time: 500, end_time: 2_000,
      }),
    ];
    state.programs = [program({ airing_key: 'current', start_time: 1_000, stop_time: 2_000 })];
    const { reconcileDueRuleSchedules } = await import('./recording-scheduler.js');

    reconcileDueRuleSchedules(1_000);

    expect(state.recordings.find(item => item.id === 'deleted')?.status).toBe('cancelled');
    expect(state.recordings.find(item => item.id === 'disabled')?.status).toBe('cancelled');
    expect(state.recordings.find(item => item.id === 'stale')).toMatchObject({
      status: 'scheduled', rule_revision: 2, cadence_slot: null, start_time: 1_000,
    });
  });

  it('retries after failure and cancels scheduled airings that no longer fit the cadence', async () => {
    state.rules = [rule({ cadence_mode: 'occurrence', cadence_interval: 3, cadence_last_success_start: 10_000 })];
    state.recordings = [
      recording({ id: 'done', airing_key: 'a1', start_time: 10_000, status: 'completed', content_key: null }),
      recording({ id: 'failed', airing_key: 'a4', start_time: 40_000, status: 'failed', content_key: null }),
      recording({ id: 'obsolete', airing_key: 'a7', start_time: 70_000, status: 'scheduled', content_key: null }),
    ];
    state.programs = [5, 6, 7, 8].map(value => program({
      airing_key: `a${value}`, start_time: value * 10_000, stop_time: value * 10_000 + 5_000,
    }));
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.inserted.map(item => item.airing_key)).toEqual(['a5']);
    expect(state.updates).toContainEqual({
      id: 'obsolete', updates: expect.objectContaining({ status: 'cancelled' }),
    });
  });

  it('schedules the first matching programme at or after the daily local time', async () => {
    const local = (day: number, hours: number, minutes: number) => Date.UTC(2026, 0, day, hours, minutes);
    state.rules = [rule({ cadence_mode: 'daily', daily_start_minutes: 21 * 60 })];
    state.programs = [
      program({ airing_key: 'early', start_time: local(1, 20, 30), stop_time: local(1, 21, 0) }),
      program({ airing_key: 'day1', start_time: local(1, 21, 15), stop_time: local(1, 22, 0) }),
      program({ airing_key: 'later', start_time: local(1, 22, 0), stop_time: local(1, 23, 0) }),
      program({ airing_key: 'day2', start_time: local(2, 21, 5), stop_time: local(2, 22, 0) }),
    ];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.inserted.map(item => item.airing_key)).toEqual(['day1']);
  });

  it('cancels future schedules that no longer match an edited rule', async () => {
    state.rules = [rule({ match_title: 'Different Show' })];
    state.recordings = [recording({ id: 'old', status: 'scheduled', airing_key: 'old-airing', content_key: null })];
    state.programs = [program({ airing_key: 'old-airing' })];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.updates).toContainEqual({
      id: 'old', updates: expect.objectContaining({ status: 'cancelled' }),
    });
  });

  it('uses the full future horizon and filters repeats and content duplicates', async () => {
    const moved = recording({
      id: 'moved', status: 'scheduled', airing_key: 'airing-moved', content_key: 'seen-content',
      start_time: 5_000, end_time: 6_000,
    });
    state.recordings = [recording(), moved];
    state.programs = [
      program({ airing_key: 'airing-repeat', is_repeat: 1, start_time: 100_000_000, stop_time: 100_001_000 }),
      program({ airing_key: 'airing-duplicate', content_key: 'seen-content', is_repeat: 0, start_time: 100_002_000, stop_time: 100_003_000 }),
      program({ airing_key: 'airing-future', content_key: 'fresh-content', is_repeat: null, start_time: 100_004_000, stop_time: 100_005_000 }),
      program({ airing_key: 'airing-moved', content_key: 'seen-content', start_time: 7_000, stop_time: 8_000 }),
    ];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.programQueries).toEqual([['c1', 1_000]]);
    expect(state.inserted.map(item => item.airing_key)).toEqual(['airing-future']);
    expect(state.updates).toContainEqual({ id: 'moved', updates: expect.objectContaining({ status: 'cancelled' }) });
  });
});
