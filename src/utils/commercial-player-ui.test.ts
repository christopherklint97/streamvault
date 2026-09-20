import { describe, expect, it } from 'vitest';
import { formatCommercialBreakSummary, getCommercialPlayerUiState, isCommercialUndoKey } from './commercial-player-ui';
import { KEY_CODES } from './keys';
import type { CommercialSkipSnapshot } from '../services/commercialSkipSession';

function snapshot(overrides: Partial<CommercialSkipSnapshot> = {}): CommercialSkipSnapshot {
  return {
    recordingId: 'r1',
    generation: 1,
    phase: 'ready',
    enabled: true,
    segments: [],
    seekPending: false,
    undo: null,
    ...overrides,
  };
}

describe('commercial player UI state', () => {
  it('shows recording-only skip status and exposes Undo only after a successful skip', () => {
    expect(getCommercialPlayerUiState(snapshot(), 'r1', false)).toEqual({
      visible: true,
      statusLabel: 'Commercial skip: On',
      canUndo: false,
    });
    expect(getCommercialPlayerUiState(snapshot({
      undo: { segmentId: 'ad', originalPosition: 10, targetPosition: 20, expiresAt: 100 },
    }), 'r1', false).canUndo).toBe(true);
    expect(getCommercialPlayerUiState(snapshot(), undefined, false).visible).toBe(false);
  });

  it('excludes cast playback from commercial controls', () => {
    expect(getCommercialPlayerUiState(snapshot({
      undo: { segmentId: 'ad', originalPosition: 10, targetPosition: 20, expiresAt: 100 },
    }), 'r1', true)).toEqual({ visible: false, statusLabel: '', canUndo: false });
  });

  it('reserves only the yellow key for active Undo', () => {
    expect(isCommercialUndoKey(KEY_CODES.YELLOW, true)).toBe(true);
    expect(isCommercialUndoKey(KEY_CODES.YELLOW, false)).toBe(false);
    expect(isCommercialUndoKey(KEY_CODES.GREEN, true)).toBe(false);
    expect(isCommercialUndoKey(KEY_CODES.RED, true)).toBe(false);
  });

  it('formats an accessible summary of accepted commercial breaks', () => {
    expect(formatCommercialBreakSummary([
      { id: 'one', startSeconds: 10, endSeconds: 40, source: 'manual', confidence: 1, state: 'accepted' },
      { id: 'two', startSeconds: 80, endSeconds: 110, source: 'manual', confidence: 1, state: 'accepted' },
    ])).toBe('2 commercial breaks, 1 minute total');
    expect(formatCommercialBreakSummary([])).toBe('No commercial breaks marked');
  });
});
