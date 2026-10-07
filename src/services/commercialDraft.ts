import type { CommercialSegment, CommercialSegmentsResponse } from '../types';

export interface CommercialDraftState {
  recordingId: string;
  phase: 'loading' | 'ready' | 'failed';
  segments: CommercialSegment[];
  baselineFingerprint: string | null;
  edited: boolean;
}

function cloneSegments(segments: CommercialSegment[]): CommercialSegment[] {
  return segments.map((segment) => ({ ...segment }));
}

function fingerprint(segments: CommercialSegment[]): string {
  return JSON.stringify(segments);
}

export function beginCommercialDraft(recordingId: string): CommercialDraftState {
  return {
    recordingId,
    phase: 'loading',
    segments: [],
    baselineFingerprint: null,
    edited: false,
  };
}

export function editCommercialDraft(
  state: CommercialDraftState,
  segments: CommercialSegment[],
): CommercialDraftState {
  return { ...state, segments: cloneSegments(segments), edited: true };
}

export function applyCommercialDraftLoad(
  state: CommercialDraftState,
  recordingId: string,
  metadata: CommercialSegmentsResponse | null,
): CommercialDraftState {
  if (recordingId !== state.recordingId) return state;
  if (!metadata) return { ...state, phase: 'failed', baselineFingerprint: null };
  const baselineFingerprint = fingerprint(metadata.segments);
  if (state.edited) return { ...state, phase: 'ready', baselineFingerprint };
  return {
    ...state,
    phase: 'ready',
    segments: cloneSegments(metadata.segments),
    baselineFingerprint,
    edited: false,
  };
}

export function applyCommercialDraftSave(
  state: CommercialDraftState,
  metadata: CommercialSegmentsResponse,
): CommercialDraftState {
  const segments = cloneSegments(metadata.segments);
  return {
    ...state,
    phase: 'ready',
    segments,
    baselineFingerprint: fingerprint(segments),
    edited: false,
  };
}

export function isCommercialDraftEditable(state: CommercialDraftState): boolean {
  return state.phase === 'ready';
}

export function isCommercialDraftDirty(state: CommercialDraftState): boolean {
  return state.phase === 'ready'
    && state.baselineFingerprint !== null
    && fingerprint(state.segments) !== state.baselineFingerprint;
}
