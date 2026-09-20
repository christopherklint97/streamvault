import { describe, expect, it } from 'vitest';
import {
  getRecordingAnalysisError,
  getRecordingAnalysisStatus,
  getRecordingCommercialSeconds,
} from './recording-commercial';
import type { Recording } from '../types';

function recording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: 'r1',
    channel_id: 'c1',
    channel_name: 'Channel',
    title: 'Show',
    status: 'completed',
    start_time: 0,
    end_time: 100,
    actual_start: 0,
    actual_end: 100,
    file_path: 'recording.mp4',
    file_size: 1,
    duration: 100,
    error: null,
    rule_id: null,
    program_title: null,
    created_at: 0,
    analysis_state: 'not_requested',
    analysis_error: null,
    commercial_segment_count: 0,
    commercial_seconds: 0,
    commercial_skip_override: null,
    ...overrides,
  };
}

describe('recording commercial API fields', () => {
  it('normalizes persisted server analysis states for display logic', () => {
    expect(getRecordingAnalysisStatus(recording({ analysis_state: 'not_requested' }))).toBe('not_analyzed');
    expect(getRecordingAnalysisStatus(recording({ analysis_state: 'completed' }))).toBe('ready');
    expect(getRecordingAnalysisStatus(recording({ analysis_state: 'analyzing' }))).toBe('analyzing');
  });

  it('reads error and total seconds from the server recording contract', () => {
    const value = recording({ analysis_error: 'detector failed', commercial_seconds: 45.5 });
    expect(getRecordingAnalysisError(value)).toBe('detector failed');
    expect(getRecordingCommercialSeconds(value)).toBe(45.5);
  });
});
