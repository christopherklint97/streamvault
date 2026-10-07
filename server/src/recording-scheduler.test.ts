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
}));

vi.mock('./db.js', () => ({
  getEnabledRecordingRules: () => state.rules,
  getProgramsByChannel: (...args: unknown[]) => { state.programQueries.push(args); return state.programs; },
  getRecordedContentKeysByRuleId: (ruleId: string) => new Set(
    state.recordings
      .filter(recording => recording.rule_id === ruleId && recording.content_key && !['cancelled', 'failed'].includes(recording.status))
      .map(recording => recording.content_key!),
  ),
  getRecordingByAiringKey: (key: string) => state.recordings.find(recording => recording.airing_key === key),
  getUpcomingRecordings: () => [],
  getRecordingsByRuleId: (ruleId: string) => state.recordings.filter(recording => recording.rule_id === ruleId),
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
  getRecordings: () => [],
  deleteRecording: vi.fn(),
  getConfig: (_key: string, fallback = '') => fallback,
  saveProgramsForChannels: vi.fn(),
}));

vi.mock('./recorder.js', () => ({
  startRecording: vi.fn(async (id: string) => { state.lifecycleCalls.push(`start:${id}`); }),
  stopRecording: vi.fn(async (id: string) => { state.lifecycleCalls.push(`stop:${id}`); }),
  getActiveCount: () => 0,
  getRecordingsDiskUsage: () => 0,
  deleteRecordingFile: vi.fn(async () => 0),
}));

vi.mock('./xtream.js', () => ({ fetchXtreamShortEpg: vi.fn() }));
vi.mock('./rule-epg-refresh.js', () => ({ refreshRuleChannelPrograms: vi.fn() }));

function rule(overrides: Partial<DBRecordingRule> = {}): DBRecordingRule {
  return {
    id: 'rule-1', channel_id: 'c1', channel_name: 'Channel', match_title: 'Show',
    match_type: 'exact', enabled: 1, padding_before: 0, padding_after: 0,
    max_recordings: 0, airing_policy: 'every', repeat_policy: 'include_unknown', created_at: 1,
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
});

describe('recording scheduler rule integration', () => {
  it('stops expired captures before attempting to start due jobs', async () => {
    state.rules = [];
    state.recordings = [
      recording({ id: 'due', status: 'scheduled', start_time: 500, end_time: 5_000 }),
      recording({ id: 'expired', status: 'recording', start_time: 100, end_time: 900 }),
    ];
    const scheduler = await import('./recording-scheduler.js');

    scheduler.startScheduler();
    await scheduler.stopScheduler();

    expect(state.lifecycleCalls).toEqual(['stop:expired', 'start:due']);
  });

  it('schedules trustworthy first-run metadata for a new-only rule', async () => {
    state.rules = [rule({ repeat_policy: 'new_only' })];
    state.programs = [program({ airing_key: 'first-run', is_repeat: null, is_new: 1 })];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.inserted.map(item => item.airing_key)).toEqual(['first-run']);
  });

  it('does not let a failed recording suppress a later successful content attempt', async () => {
    state.recordings = [recording({ status: 'failed', airing_key: 'failed-airing', content_key: 'episode-1' })];
    state.programs = [program({ airing_key: 'retry-airing', content_key: 'episode-1', is_repeat: 0 })];
    const { matchRules } = await import('./recording-scheduler.js');

    matchRules();

    expect(state.inserted.map(item => item.airing_key)).toEqual(['retry-airing']);
  });

  it('uses the full future horizon, filters repeats/content duplicates, and still reconciles known airings', async () => {
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
    expect(state.updates).toContainEqual({
      id: 'moved',
      updates: expect.objectContaining({ start_time: 7_000, end_time: 8_000 }),
    });
  });
});
