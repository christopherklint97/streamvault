import { archiveStore, completeRecordingAndAdvanceCadence, getRecording, getRecordings, updateRecordingIfStatus,
  markRecordingRuleCadenceRetry } from './db.js';
import type { DBRecording } from './db.js';
import { logger } from './logger.js';
import { waitForSharedArchiveTail } from './segmented-tail.js';

interface Capture {
  start(channelId: string, forShow: boolean): void;
  stopShow(channelId: string): Promise<void>;
}
let capture: Capture | undefined;
const active = new Map<string, string>();
const stopping = new Map<string, Promise<void>>();

export function setSegmentedCapture(value: Capture): void { capture = value; }
export function segmentedActive(id: string): boolean { return active.has(id) || stopping.has(id); }
export function segmentedCaptureCount(): number { return new Set(active.values()).size; }

export function onSegmentedChunk(channelId: string): void {
  for (const [id, channel] of active) {
    if (channel !== channelId) continue;
    const rec = getRecording(id);
    if (rec?.status !== 'recording') continue;
    for (const chunk of archiveStore.overlap(channelId, rec.start_time, rec.end_time)) {
      archiveStore.addRecordingRef(id, chunk.id);
    }
  }
}

export function recoverSegmentedRefs(): void {
  for (const rec of getRecordings()) {
    if (rec.capture_format !== 'segmented' || !['recording', 'finalizing', 'completed'].includes(rec.status)) continue;
    for (const chunk of archiveStore.overlap(rec.channel_id, rec.start_time, rec.end_time)) {
      archiveStore.addRecordingRef(rec.id, chunk.id);
    }
  }
}

function failSegmented(rec: DBRecording, message: string): void {
  if (updateRecordingIfStatus(rec.id, ['recording', 'finalizing', 'scheduled'], {
    status: 'failed', actual_end: Date.now(), error: message,
  })) markRecordingRuleCadenceRetry(rec.rule_id, rec.rule_revision ?? null,
    rec.program_start_time ?? rec.start_time, rec.airing_key ?? null);
  archiveStore.removeRecordingRefs(rec.id);
}

export function startSegmentedRecording(rec: DBRecording): void {
  if (!capture) throw new Error('Segmented capture is unavailable');
  if (active.has(rec.id) || stopping.has(rec.id)) return;
  if (!archiveStore.getArchive(rec.channel_id)) archiveStore.configure(rec.channel_id, rec.channel_name, false, 24);
  if (!updateRecordingIfStatus(rec.id, ['scheduled', 'recording'], {
    status: 'recording', actual_start: rec.actual_start ?? Date.now(), error: null,
  })) return;
  active.set(rec.id, rec.channel_id);
  onSegmentedChunk(rec.channel_id);
  capture.start(rec.channel_id, true);
}

export function stopSegmentedRecording(id: string, resume = false): Promise<void> {
  const existing = stopping.get(id);
  if (existing) return existing;
  const task = (async () => {
    const rec = getRecording(id);
    if (!rec) return;
    const channelId = active.get(id);
    active.delete(id);
    if (channelId && ![...active.values()].includes(channelId)) await capture?.stopShow(channelId);
    const current = getRecording(id);
    if (!current || current.status === 'cancelled') return;
    if (resume && Date.now() < current.end_time) {
      updateRecordingIfStatus(id, ['recording'], { status: 'scheduled', error: null });
      return;
    }
    if (channelId && archiveStore.getArchive(channelId)?.enabled && Date.now() >= current.end_time) {
      const covered = await waitForSharedArchiveTail(
        () => archiveStore.coverage(channelId).availableTo, current.end_time,
      );
      if (!covered) logger.warn(`Segmented recording ${id}: source stopped before the final complete archive chunk`);
    }
    if (!updateRecordingIfStatus(id, ['recording', 'scheduled', 'finalizing'], { status: 'finalizing', actual_end: Date.now() })) return;
    const chunks = archiveStore.overlap(rec.channel_id, rec.start_time, Math.min(Date.now(), rec.end_time));
    if (!chunks.length) {
      failSegmented(rec, 'No complete segments were captured');
      return;
    }
    for (const chunk of chunks) archiveStore.addRecordingRef(id, chunk.id);
    const saved = completeRecordingAndAdvanceCadence(id, {
      status: 'completed', actual_end: Date.now(), file_path: null, master_file_path: null,
      derivative_file_path: null, derivative_error: null,
      file_size: chunks.reduce((sum, c) => sum + c.size, 0),
      duration: chunks.reduce((sum, c) => sum + c.duration, 0), error: null,
      analysis_state: 'not_requested', analysis_error: 'Automatic commercial analysis requires a contiguous file; manually set markers for segmented recordings',
    }, rec.rule_id, rec.rule_revision ?? null, rec.program_start_time ?? null, rec.airing_key ?? null);
    if (!saved) archiveStore.removeRecordingRefs(id);
    else if (rec.rule_id) queueMicrotask(() => {
      void import('./recorder.js').then(({ enforceRuleRetention }) => enforceRuleRetention(rec.rule_id!))
        .catch(error => logger.warn(`Segmented retention ${rec.rule_id}: ${error}`));
    });
  })().catch(error => {
    logger.error(`Segmented recording ${id}: ${error instanceof Error ? error.message : error}`);
    const rec = getRecording(id);
    if (rec) failSegmented(rec, String(error));
  }).finally(() => { stopping.delete(id); });
  stopping.set(id, task);
  return task;
}

export async function cancelSegmentedRecording(id: string): Promise<void> {
  updateRecordingIfStatus(id, ['scheduled', 'recording', 'finalizing'], { status: 'cancelled', actual_end: Date.now() });
  await stopSegmentedRecording(id);
  archiveStore.removeRecordingRefs(id);
}

export async function stopAllSegmentedRecordings(): Promise<void> {
  await Promise.all([...active.keys()].map(id => stopSegmentedRecording(id, true)));
}
