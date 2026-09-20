import type { CommercialAnalysisStatus, Recording } from '../types';

export type DisplayCommercialAnalysisStatus =
  | 'not_analyzed'
  | 'queued'
  | 'analyzing'
  | 'review_needed'
  | 'ready'
  | 'failed';

export function normalizeCommercialAnalysisStatus(
  status: CommercialAnalysisStatus | null | undefined,
): DisplayCommercialAnalysisStatus {
  if (status === 'not_requested' || !status) return 'not_analyzed';
  if (status === 'completed') return 'ready';
  return status;
}

export function getRecordingAnalysisStatus(recording: Recording): DisplayCommercialAnalysisStatus {
  return normalizeCommercialAnalysisStatus(recording.analysis_state);
}

export function getRecordingAnalysisError(recording: Recording): string | null {
  return recording.analysis_error ?? null;
}

export function getRecordingCommercialSeconds(recording: Recording): number {
  return Number.isFinite(recording.commercial_seconds) ? recording.commercial_seconds ?? 0 : 0;
}
