import type { CommercialSegment } from '../types';
import type { CommercialSkipSnapshot } from '../services/commercialSkipSession';
import { KEY_CODES } from './keys';

export interface CommercialPlayerUiState {
  visible: boolean;
  statusLabel: string;
  canUndo: boolean;
}

export function getCommercialPlayerUiState(
  snapshot: CommercialSkipSnapshot,
  recordingId: string | undefined,
  castActive: boolean,
): CommercialPlayerUiState {
  if (!recordingId || snapshot.recordingId !== recordingId || castActive) {
    return { visible: false, statusLabel: '', canUndo: false };
  }

  const statusLabel = snapshot.phase === 'loading'
    ? 'Commercial skip: Loading'
    : snapshot.phase === 'unavailable'
      ? 'Commercial skip: Unavailable'
      : snapshot.enabled
        ? 'Commercial skip: On'
        : 'Commercial skip: Off';
  return {
    visible: true,
    statusLabel,
    canUndo: snapshot.undo !== null,
  };
}

export function formatCommercialBreakSummary(segments: readonly CommercialSegment[]): string {
  const accepted = segments.filter((segment) => segment.state === 'accepted');
  if (accepted.length === 0) return 'No commercial breaks marked';
  const seconds = Math.round(accepted.reduce(
    (total, segment) => total + Math.max(0, segment.endSeconds - segment.startSeconds),
    0,
  ));
  const countLabel = `${accepted.length} commercial ${accepted.length === 1 ? 'break' : 'breaks'}`;
  if (seconds < 60) return `${countLabel}, ${seconds} ${seconds === 1 ? 'second' : 'seconds'} total`;
  const minutes = Math.round(seconds / 60);
  return `${countLabel}, ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} total`;
}

export function isCommercialUndoKey(keyCode: number, canUndo: boolean): boolean {
  return canUndo && keyCode === KEY_CODES.YELLOW;
}
