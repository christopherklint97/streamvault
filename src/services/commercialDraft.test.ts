import { describe, expect, it } from 'vitest';
import type { CommercialSegmentsResponse } from '../types';
import {
  applyCommercialDraftLoad,
  applyCommercialDraftSave,
  beginCommercialDraft,
  editCommercialDraft,
  isCommercialDraftDirty,
  isCommercialDraftEditable,
} from './commercialDraft';

const loaded: CommercialSegmentsResponse = {
  analysis: { status: 'ready', error: null, detector: null, profileVersion: null },
  segments: [{
    id: 'server', startSeconds: 10, endSeconds: 20, source: 'manual', confidence: 1, state: 'accepted',
  }],
  autoSkipOverride: null,
  effectiveAutoSkip: true,
};

describe('recording commercial editor draft lifecycle', () => {
  it('is not editable or dirty until metadata initializes successfully', () => {
    const draft = beginCommercialDraft('r1');
    expect(isCommercialDraftEditable(draft)).toBe(false);
    expect(isCommercialDraftDirty(draft)).toBe(false);
  });

  it('never overwrites edits made while the initial request is pending', () => {
    const pending = beginCommercialDraft('r1');
    const localSegments = [{
      id: 'local', startSeconds: 30, endSeconds: 40, source: 'manual' as const,
      confidence: 1, state: 'accepted' as const,
    }];
    const edited = editCommercialDraft(pending, localSegments);
    const initialized = applyCommercialDraftLoad(edited, 'r1', loaded);

    expect(initialized.segments).toEqual(localSegments);
    expect(isCommercialDraftEditable(initialized)).toBe(true);
    expect(isCommercialDraftDirty(initialized)).toBe(true);
  });

  it('keeps a failed metadata load non-editable', () => {
    const failed = applyCommercialDraftLoad(beginCommercialDraft('r1'), 'r1', null);
    expect(failed.phase).toBe('failed');
    expect(isCommercialDraftEditable(failed)).toBe(false);
    expect(isCommercialDraftDirty(failed)).toBe(false);
  });

  it('updates the baseline from the mutation response after saving', () => {
    const initialized = applyCommercialDraftLoad(beginCommercialDraft('r1'), 'r1', loaded);
    const edited = editCommercialDraft(initialized, [{ ...loaded.segments[0], endSeconds: 25 }]);
    expect(isCommercialDraftDirty(edited)).toBe(true);

    const savedResponse = { ...loaded, segments: edited.segments };
    const saved = applyCommercialDraftSave(edited, savedResponse);
    expect(isCommercialDraftDirty(saved)).toBe(false);
  });
});
