// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { DBCommercialSegment } from './commercial-store.js';
import type { DBRecording } from './db.js';
import {
  mapCommercialSegmentsResponse,
  mapRecordingForApi,
  deriveProgramAiringKey,
  parseBooleanConfig,
  validateCommercialSegmentReplacement,
  validateCommercialSkipOverride,
  validateFromProgramLookup,
  validateRecordingRulePayload,
} from './recording-api.js';

function recording(overrides: Partial<DBRecording> = {}): DBRecording {
  return {
    id: 'r1', channel_id: 'c1', channel_name: 'ESPN', title: 'SportsCenter', status: 'completed',
    start_time: 1, end_time: 2, actual_start: 1, actual_end: 2, file_path: 'r1.mp4',
    file_size: 10, duration: 120, error: null, rule_id: null, program_title: 'SportsCenter', created_at: 1,
    ...overrides,
  };
}

function segment(overrides: Partial<DBCommercialSegment> = {}): DBCommercialSegment {
  return {
    id: 4, recording_id: 'r1', start_seconds: 10, end_seconds: 20,
    detector: 'comskip', confidence: null, detector_version: 'a140b6a', review_state: 'suggested',
    created_at: 1, updated_at: 1, ...overrides,
  };
}

describe('recording API mapping', () => {
  it('exposes the exact commercial summary fields expected by the frontend', () => {
    const result = mapRecordingForApi(recording({
      analysis_state: 'not_requested', analysis_error: 'old', commercial_segment_count: 2,
      commercial_seconds: 35.5, commercial_skip_override: 1, master_file_path: 'r1.ts',
    }));
    expect(result).toMatchObject({
      commercial_analysis_status: 'not_analyzed',
      commercial_analysis_error: 'old',
      commercial_segment_count: 2,
      commercial_total_seconds: 35.5,
      commercial_skip_override: true,
      master_path: 'r1.ts',
    });
  });

  it('maps commercial analysis, segments, override, and effective auto-skip contract', () => {
    expect(mapCommercialSegmentsResponse(
      recording({ analysis_state: 'review_needed', analysis_profile: 'espn-v1', commercial_skip_override: null }),
      [segment()],
      true,
    )).toEqual({
      analysis: { status: 'review_needed', error: null, detector: 'comskip', profileVersion: 'espn-v1' },
      segments: [{
        id: '4', startSeconds: 10, endSeconds: 20, source: 'detector', confidence: null,
        state: 'suggested', detectorVersion: 'a140b6a', profileVersion: 'espn-v1',
      }],
      autoSkipOverride: null,
      effectiveAutoSkip: true,
    });
  });
});

describe('commercial API validation', () => {
  it('validates and sorts a complete manual/reviewed segment replacement', () => {
    const result = validateCommercialSegmentReplacement([
      { startSeconds: 30, endSeconds: 40, source: 'manual', confidence: 1, state: 'accepted' },
      { startSeconds: 5, endSeconds: 10, source: 'detector', confidence: null, state: 'rejected', detectorVersion: 'a140b6a' },
    ], 120);
    expect(result).toEqual([
      { startSeconds: 5, endSeconds: 10, detector: 'comskip', confidence: null, detectorVersion: 'a140b6a', reviewState: 'rejected' },
      { startSeconds: 30, endSeconds: 40, detector: 'manual', confidence: 1, detectorVersion: 'manual-v1', reviewState: 'accepted' },
    ]);
  });

  it('rejects invalid states, confidence, duration overflow, overlap, and non-arrays', () => {
    expect(() => validateCommercialSegmentReplacement({}, 100)).toThrow(/array/i);
    expect(() => validateCommercialSegmentReplacement([{ startSeconds: 1, endSeconds: 2, source: 'manual', state: 'maybe' }], 100)).toThrow(/state/i);
    expect(() => validateCommercialSegmentReplacement([{ startSeconds: 1, endSeconds: 2, source: 'manual', state: 'accepted', confidence: 2 }], 100)).toThrow(/confidence/i);
    expect(() => validateCommercialSegmentReplacement([{ startSeconds: 1, endSeconds: 101, source: 'manual', state: 'accepted' }], 100)).toThrow(/duration/i);
    expect(() => validateCommercialSegmentReplacement([
      { startSeconds: 1, endSeconds: 10, source: 'manual', state: 'accepted' },
      { startSeconds: 9, endSeconds: 20, source: 'manual', state: 'accepted' },
    ], 100)).toThrow(/overlap/i);
    expect(() => validateCommercialSegmentReplacement(
      Array.from({ length: 1001 }, (_, index) => ({ startSeconds: index * 2, endSeconds: index * 2 + 1, source: 'manual', state: 'accepted' })),
      10_000,
    )).toThrow(/too many/i);
  });

  it('prefers canonical airing identity and strictly validates the legacy fallback', () => {
    expect(validateFromProgramLookup({ airingKey: 'xtream:abc', programStart: 'bad' })).toEqual({
      kind: 'airingKey', airingKey: 'xtream:abc',
    });
    expect(validateFromProgramLookup({ channelId: 'c1', programStart: 100, programStop: 200 })).toEqual({
      kind: 'legacy', channelId: 'c1', programStart: 100, programStop: 200,
    });
    expect(() => validateFromProgramLookup({ channelId: 'c1', programStart: 200, programStop: 100 })).toThrow(/programStop/i);
    expect(() => validateFromProgramLookup({ airingKey: '' })).toThrow(/airingKey/i);
  });

  it('derives the same fallback airing identity for id-less program retries', () => {
    const base = { channel_id: 'c1', source: 'legacy', provider_event_id: null, start_time: 100, stop_time: 200 };
    expect(deriveProgramAiringKey({ ...base, airing_key: 'stable' })).toBe('stable');
    expect(deriveProgramAiringKey(base)).toBe(deriveProgramAiringKey({ ...base }));
    expect(deriveProgramAiringKey(base)).not.toBe(deriveProgramAiringKey({ ...base, stop_time: 201 }));
  });

  it('accepts only boolean or null overrides and strict persisted booleans', () => {
    expect(validateCommercialSkipOverride(true)).toBe(true);
    expect(validateCommercialSkipOverride(null)).toBe(null);
    expect(() => validateCommercialSkipOverride(1)).toThrow(/boolean/i);
    expect(parseBooleanConfig('true', false)).toBe(true);
    expect(parseBooleanConfig('false', true)).toBe(false);
    expect(parseBooleanConfig('garbage', false)).toBe(false);
  });

  it('validates bounded recurring-rule payloads and repeat policy values', () => {
    expect(validateRecordingRulePayload({
      channelId: 'c1', channelName: 'ESPN', matchTitle: 'SportsCenter', matchType: 'exact',
      repeatPolicy: 'new_only', paddingBefore: 1000, paddingAfter: 2000, maxRecordings: 0,
      retentionLimit: 10, airingPolicy: 'every',
    }, false)).toEqual({
      channel_id: 'c1', channel_name: 'ESPN', match_title: 'SportsCenter', match_type: 'exact',
      repeat_policy: 'new_only', padding_before: 1000, padding_after: 2000, max_recordings: 0,
      retention_count: 10, airing_policy: 'every',
    });
    expect(validateRecordingRulePayload({ channelId: 'c1', matchTitle: 'T' }, false).repeat_policy).toBe('include_unknown');
    for (const repeatPolicy of ['all', 'include_unknown', 'new_only']) {
      expect(validateRecordingRulePayload({ repeatPolicy }, true).repeat_policy).toBe(repeatPolicy);
    }
    expect(() => validateRecordingRulePayload({ repeatPolicy: 'sometimes' }, true)).toThrow(/repeatPolicy/i);
    expect(() => validateRecordingRulePayload({ channelId: 'c', matchTitle: 'T', paddingBefore: -1 }, false)).toThrow(/paddingBefore/i);
    expect(() => validateRecordingRulePayload({ channelId: 'c', matchTitle: 'T', maxRecordings: 1.5 }, false)).toThrow(/maxRecordings/i);
    expect(() => validateRecordingRulePayload({ retentionLimit: -1 }, true)).toThrow(/retentionLimit/i);
    expect(() => validateRecordingRulePayload({ airingPolicy: 'latest' }, true)).toThrow(/airingPolicy/i);
    expect(validateRecordingRulePayload({ retentionLimit: 1, airingPolicy: 'once' }, true)).toEqual({
      retention_count: 1, airing_policy: 'once',
    });
  });
});
