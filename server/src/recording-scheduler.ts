import {
  getRecordingsByStatus, getUpcomingRecordings, getEnabledRecordingRules,
  getProgramsByChannel, insertRecording, getRecordings,
  deleteRecording, getConfig, getRecordingsByRuleId,
} from './db.js';
import { startRecording, stopRecording, getActiveCount, getRecordingsDiskUsage, deleteRecordingFile } from './recorder.js';
import { logger } from './logger.js';
import { randomUUID } from 'node:crypto';

let tickTimer: ReturnType<typeof setInterval> | null = null;
let lastRuleCheck = 0;
let lastCleanup = 0;
const TICK_INTERVAL = 60_000; // 60 seconds
const RULE_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

export function startScheduler(): void {
  if (tickTimer) return;
  logger.info('Recording scheduler started');
  tick(); // Run immediately
  tickTimer = setInterval(tick, TICK_INTERVAL);
}

export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  logger.info('Recording scheduler stopped');
}

function tick(): void {
  const now = Date.now();

  // 1. Start scheduled recordings whose start time has arrived
  const scheduled = getRecordingsByStatus('scheduled');
  for (const rec of scheduled) {
    if (rec.start_time <= now) {
      logger.info(`Scheduler: starting recording ${rec.id} "${rec.title}"`);
      startRecording(rec.id).catch(err => {
        logger.error(`Scheduler: failed to start recording ${rec.id}: ${err}`);
      });
    }
  }

  // 2. Stop active recordings whose end time has passed
  const recording = getRecordingsByStatus('recording');
  for (const rec of recording) {
    if (rec.end_time <= now) {
      logger.info(`Scheduler: stopping recording ${rec.id} "${rec.title}" (end time reached)`);
      stopRecording(rec.id).catch(err => {
        logger.error(`Scheduler: failed to stop recording ${rec.id}: ${err}`);
      });
    }
  }

  // 3. Periodic rule matching (every hour)
  if (now - lastRuleCheck >= RULE_CHECK_INTERVAL) {
    lastRuleCheck = now;
    matchRules();
  }

  // 4. Periodic cleanup (every hour)
  if (now - lastCleanup >= CLEANUP_INTERVAL) {
    lastCleanup = now;
    runCleanup();
  }
}

/** Match recording rules against EPG data and create scheduled recordings */
export function matchRules(): void {
  const rules = getEnabledRecordingRules();
  if (rules.length === 0) return;

  const now = Date.now();
  const lookAhead = 24 * 60 * 60 * 1000; // 24 hours

  for (const rule of rules) {
    const programs = getProgramsByChannel(rule.channel_id, now, now + lookAhead);

    for (const program of programs) {
      // Check title match
      let matches = false;
      if (rule.match_type === 'exact') {
        matches = program.title.toLowerCase() === rule.match_title.toLowerCase();
      } else {
        matches = program.title.toLowerCase().includes(rule.match_title.toLowerCase());
      }
      if (!matches) continue;

      // Check for duplicate (same channel, overlapping time)
      const startTime = program.start_time - rule.padding_before;
      const endTime = program.stop_time + rule.padding_after;
      const existing = getUpcomingRecordings(startTime - 60_000, endTime + 60_000);
      const isDuplicate = existing.some(r =>
        r.channel_id === rule.channel_id &&
        Math.abs(r.start_time - startTime) < 120_000
      );
      if (isDuplicate) continue;

      // Check max_recordings limit
      if (rule.max_recordings > 0) {
        const ruleRecordings = getRecordingsByRuleId(rule.id);
        const nonCancelled = ruleRecordings.filter(r => r.status !== 'cancelled');
        if (nonCancelled.length >= rule.max_recordings) continue;
      }

      // Create scheduled recording
      const id = randomUUID();
      insertRecording({
        id,
        channel_id: rule.channel_id,
        channel_name: rule.channel_name,
        title: program.title,
        status: 'scheduled',
        start_time: startTime,
        end_time: endTime,
        actual_start: null,
        actual_end: null,
        file_path: null,
        file_size: 0,
        duration: 0,
        error: null,
        rule_id: rule.id,
        program_title: program.title,
        created_at: Date.now(),
      });
      logger.info(`Rule "${rule.match_title}": scheduled recording for "${program.title}" at ${new Date(startTime).toISOString()}`);
    }
  }
}

/** Clean up old recordings based on retention settings */
function runCleanup(): void {
  const retentionDays = parseInt(getConfig('recording_retention_days', '30'), 10);
  const maxDiskGb = parseInt(getConfig('recording_max_disk_gb', '50'), 10);

  // Age-based cleanup
  if (retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const old = getRecordings({ status: 'completed' }).filter(r => r.actual_end && r.actual_end < cutoff);
    for (const rec of old) {
      logger.info(`Cleanup: deleting recording ${rec.id} "${rec.title}" (age exceeded ${retentionDays}d retention)`);
      deleteRecordingFile(rec.id);
      deleteRecording(rec.id);
    }
  }

  // Disk-based cleanup
  if (maxDiskGb > 0) {
    const maxBytes = maxDiskGb * 1_073_741_824;
    let usage = getRecordingsDiskUsage();
    if (usage > maxBytes) {
      // Delete oldest completed recordings first
      const completed = getRecordings({ status: 'completed' });
      // Sort oldest first (by actual_end ascending)
      completed.sort((a, b) => (a.actual_end ?? 0) - (b.actual_end ?? 0));
      for (const rec of completed) {
        if (usage <= maxBytes) break;
        logger.info(`Cleanup: deleting recording ${rec.id} "${rec.title}" (disk usage ${(usage / 1e9).toFixed(1)}GB > ${maxDiskGb}GB limit)`);
        const size = rec.file_size;
        deleteRecordingFile(rec.id);
        deleteRecording(rec.id);
        usage -= size;
      }
    }
  }
}

/** Get scheduler status for the API */
export function getSchedulerStatus(): { activeCount: number; diskUsageBytes: number; schedulerRunning: boolean } {
  return {
    activeCount: getActiveCount(),
    diskUsageBytes: getRecordingsDiskUsage(),
    schedulerRunning: tickTimer !== null,
  };
}
