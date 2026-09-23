import { describe, expect, it } from 'vitest';
import type { RecordingRule } from '../types';
import {
  createRecordingRuleDraft,
  minutesToRuleTime,
  recordingRuleDraftToInput,
  recordingRuleToDraft,
  repeatPolicyDescription,
  ruleMatchesTitle,
  ruleTimeToMinutes,
} from './recordingRules';

describe('recording rule creation defaults', () => {
  it('defaults a SportsCenter rule to exact matching so title variants are excluded', () => {
    const draft = createRecordingRuleDraft({ id: 'espn', name: 'ESPN' }, 'SportsCenter');

    expect(draft.matchType).toBe('exact');
    expect(ruleMatchesTitle('SportsCenter', draft.matchTitle, draft.matchType)).toBe(true);
    expect(ruleMatchesTitle('SportsCenter with Scott Van Pelt', draft.matchTitle, draft.matchType)).toBe(false);
  });

  it('defaults to the repeat policy that records new and unknown episodes and explains every option', () => {
    const draft = createRecordingRuleDraft();
    expect(draft.repeatPolicy).toBe('include_unknown');
    expect(draft.retentionLimit).toBe('');
    expect(draft.recordOnce).toBe(false);
    expect(draft.cadenceMode).toBe('every');
    expect(draft.cadenceInterval).toBe('2');
    expect(draft.dailyStartTime).toBe('21:00');
    expect(draft.scheduleTimezone).toBe('Europe/Stockholm');
    expect(draft.maxRecordings).toBe(0);
    expect(repeatPolicyDescription('all')).toContain('repeat');
    expect(repeatPolicyDescription('include_unknown')).toContain('unknown');
    expect(repeatPolicyDescription('new_only')).toContain('new');
  });

  it('maps a persisted rule into an editable draft without losing scheduling fields', () => {
    const rule: RecordingRule = {
      id: 'rule', channel_id: 'espn', channel_name: 'ESPN', match_title: 'SportsCenter',
      match_type: 'startsWith', repeat_policy: 'all', enabled: 1, padding_before: 60_000,
      padding_after: 120_000, max_recordings: 0, retention_count: 4, airing_policy: 'every',
      cadence_mode: 'daily', cadence_interval: 1, daily_start_minutes: 21 * 60 + 15, created_at: 1,
      schedule_timezone: 'Europe/Stockholm', rule_revision: 2, cadence_last_success_start: 123,
      cadence_last_success_key: 'a1',
      cadence_occurrence_progress: 0, cadence_cursor_start: 123, cadence_cursor_key: null,
      cadence_retry_start: null, cadence_retry_key: null,
    };

    expect(recordingRuleToDraft(rule)).toEqual({
      channelId: 'espn', channelName: 'ESPN', matchTitle: 'SportsCenter', matchType: 'startsWith',
      paddingBeforeMinutes: 1, paddingAfterMinutes: 2, repeatPolicy: 'all', retentionLimit: '4',
      recordOnce: false, cadenceMode: 'daily', cadenceInterval: '1', dailyStartTime: '21:15',
      scheduleTimezone: 'Europe/Stockholm', maxRecordings: 0,
    });
  });

  it('preserves a legacy lifetime cap during unrelated full-rule edits', () => {
    const rule = {
      id: 'legacy', channel_id: 'espn', channel_name: 'ESPN', match_title: 'SportsCenter',
      match_type: 'exact', repeat_policy: 'include_unknown', enabled: 1, padding_before: 0,
      padding_after: 0, max_recordings: 3, retention_count: 0, airing_policy: 'every',
      cadence_mode: 'every', cadence_interval: 1, daily_start_minutes: 0,
      schedule_timezone: 'Europe/Stockholm', rule_revision: 1, cadence_last_success_start: null,
      cadence_last_success_key: null,
      cadence_occurrence_progress: 0, cadence_cursor_start: null, cadence_cursor_key: null,
      cadence_retry_start: null, cadence_retry_key: null, created_at: 1,
    } as const;
    const draft = recordingRuleToDraft(rule);
    expect(draft.retentionLimit).toBe('');
    expect(recordingRuleDraftToInput(draft)).toEqual(expect.objectContaining({
      retentionLimit: 0,
      maxRecordings: 3,
    }));
  });

  it('converts daily local times to and from minutes after midnight', () => {
    expect(ruleTimeToMinutes('21:05')).toBe(21 * 60 + 5);
    expect(minutesToRuleTime(21 * 60 + 5)).toBe('21:05');
    expect(() => ruleTimeToMinutes('24:00')).toThrow(/time/i);
  });

  it('builds occurrence, hour, and daily scheduling payloads from a draft', () => {
    const base = createRecordingRuleDraft({ id: 'espn', name: 'ESPN' }, 'SportsCenter');
    expect(recordingRuleDraftToInput({ ...base, cadenceMode: 'occurrence', cadenceInterval: '3' }))
      .toEqual(expect.objectContaining({ cadenceMode: 'occurrence', cadenceInterval: 3, dailyStartMinutes: 0 }));
    expect(recordingRuleDraftToInput({ ...base, cadenceMode: 'hours', cadenceInterval: '12' }))
      .toEqual(expect.objectContaining({ cadenceMode: 'hours', cadenceInterval: 12, dailyStartMinutes: 0 }));
    expect(recordingRuleDraftToInput({ ...base, cadenceMode: 'daily', dailyStartTime: '21:30' }))
      .toEqual(expect.objectContaining({ cadenceMode: 'daily', cadenceInterval: 1, dailyStartMinutes: 21 * 60 + 30 }));
    expect(recordingRuleDraftToInput({ ...base, recordOnce: true, cadenceMode: 'hours', cadenceInterval: '12' }))
      .toEqual(expect.objectContaining({ airingPolicy: 'once', cadenceMode: 'every', cadenceInterval: 1 }));
    expect(() => recordingRuleDraftToInput({ ...base, cadenceMode: 'occurrence', cadenceInterval: '1' }))
      .toThrow(/every Nth/i);
  });
});
