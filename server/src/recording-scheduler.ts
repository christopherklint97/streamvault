import {
  getRecordingsByStatus, getUpcomingRecordings, getEnabledRecordingRules,
  getProgramsByChannel, insertRecordingForAiring, getRecordings,
  deleteRecording, getConfig, getRecordingsByRuleId, getRecordingByAiringKey,
  getRecordedContentKeysByRuleId, updateRecording, saveProgramsForChannels,
} from './db.js';
import {
  startRecording, stopRecording, getActiveCount, getRecordingsDiskUsage,
  deleteRecordingFile, enforceAllRuleRetentions,
} from './recorder.js';
import { logger } from './logger.js';
import { randomUUID } from 'node:crypto';
import { buildAiringKey } from './epg-identity.js';
import { matchProgramTitle, shouldIncludeRepeat, shouldSuppressContentDuplicate } from './schedule-reconciliation.js';
import { fetchXtreamShortEpg, type XtreamConfig } from './xtream.js';
import { refreshRuleChannelPrograms } from './rule-epg-refresh.js';

let tickTimer: ReturnType<typeof setInterval> | null = null;
let lastRuleCheck = 0;
let lastCleanup = 0;
let ruleRefreshInFlight: Promise<void> | null = null;
let cleanupInFlight: Promise<void> | null = null;
let tickInFlight: Promise<void> | null = null;
let schedulerStopping = false;
const TICK_INTERVAL = 60_000; // 60 seconds
const RULE_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

export function startScheduler(): void {
  if (tickTimer) return;
  schedulerStopping = false;
  logger.info('Recording scheduler started');
  void requestTick(); // Run immediately
  tickTimer = setInterval(() => { void requestTick(); }, TICK_INTERVAL);
}

export async function stopScheduler(): Promise<void> {
  schedulerStopping = true;
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  await Promise.all([tickInFlight, ruleRefreshInFlight, cleanupInFlight].filter((job): job is Promise<void> => job !== null));
  logger.info('Recording scheduler stopped');
}

function requestTick(): Promise<void> {
  if (tickInFlight) return tickInFlight;
  tickInFlight = tick().catch(error => {
    logger.error(`Recording scheduler tick failed: ${error instanceof Error ? error.message : error}`);
  }).finally(() => {
    tickInFlight = null;
  });
  return tickInFlight;
}

async function tick(): Promise<void> {
  const now = Date.now();

  // 1. Stop expired captures and wait for their capture slots to be released.
  const recording = getRecordingsByStatus('recording');
  await Promise.all(recording.map(async rec => {
    if (rec.end_time <= now) {
      logger.info(`Scheduler: stopping recording ${rec.id} "${rec.title}" (end time reached)`);
      await stopRecording(rec.id).catch(err => {
        logger.error(`Scheduler: failed to stop recording ${rec.id}: ${err}`);
      });
    }
  }));

  // 2. Start due jobs only after expired captures have released their slots.
  const scheduled = getRecordingsByStatus('scheduled');
  for (const rec of scheduled) {
    if (rec.start_time <= now) {
      logger.info(`Scheduler: starting recording ${rec.id} "${rec.title}"`);
      startRecording(rec.id).catch(err => {
        logger.error(`Scheduler: failed to start recording ${rec.id}: ${err}`);
      });
    }
  }

  // 3. Periodic rule matching (every hour)
  if (now - lastRuleCheck >= RULE_CHECK_INTERVAL) {
    lastRuleCheck = now;
    refreshRuleChannelsAndMatch();
  }

  // 4. Periodic cleanup (every hour)
  if (now - lastCleanup >= CLEANUP_INTERVAL && !cleanupInFlight) {
    lastCleanup = now;
    cleanupInFlight = runCleanup().catch(error => {
      logger.error(`Recording cleanup failed: ${error instanceof Error ? error.message : error}`);
    }).finally(() => {
      cleanupInFlight = null;
    });
  }
}

function getXtreamConfig(): XtreamConfig | null {
  const server = getConfig('xtream_server');
  const username = getConfig('xtream_username');
  const password = getConfig('xtream_password');
  return server && username && password ? { server, username, password } : null;
}

function refreshRuleChannelsAndMatch(): void {
  if (schedulerStopping || ruleRefreshInFlight) return;
  const rules = getEnabledRecordingRules();
  const config = getConfig('input_mode', 'manual') === 'xtream' ? getXtreamConfig() : null;
  if (!config || rules.length === 0) {
    matchRules();
    return;
  }
  ruleRefreshInFlight = refreshRuleChannelPrograms(
    rules.map(rule => rule.channel_id),
    streamIds => fetchXtreamShortEpg(config, streamIds, 'live_', 100),
    saveProgramsForChannels,
  ).then(count => {
    if (count > 0) logger.info(`Refreshed ${count} EPG airings for recording-rule channels`);
  }).catch(error => {
    logger.warn(`Recording-rule EPG refresh failed; preserving cached guide: ${error instanceof Error ? error.message : error}`);
  }).finally(() => {
    ruleRefreshInFlight = null;
    if (!schedulerStopping) matchRules();
  });
}

/** Match recording rules against EPG data and create scheduled recordings */
export function matchRules(): void {
  const rules = getEnabledRecordingRules();
  if (rules.length === 0) return;

  const now = Date.now();

  for (const rule of rules) {
    // Reconcile every future airing currently cached for the channel; provider
    // horizons vary and must not be truncated to an arbitrary local window.
    const programs = getProgramsByChannel(rule.channel_id, now);
    const recordedContentKeys = getRecordedContentKeysByRuleId(rule.id);
    let hasAcceptedOnceRecording = rule.airing_policy === 'once' && getRecordingsByRuleId(rule.id)
      .some(recording => !['cancelled', 'failed'].includes(recording.status));

    for (const program of programs) {
      if (!matchProgramTitle(program.title, rule.match_title, rule.match_type)) continue;

      const startTime = program.start_time - rule.padding_before;
      const endTime = program.stop_time + rule.padding_after;
      const airingKey = program.airing_key ?? buildAiringKey(
        program.source ?? 'legacy',
        program.channel_id,
        program.provider_event_id,
        program.start_time,
        program.stop_time,
      );
      const existingAiring = getRecordingByAiringKey(airingKey);
      if (existingAiring) {
        if (existingAiring.status === 'scheduled' &&
            (existingAiring.start_time !== startTime || existingAiring.end_time !== endTime)) {
          updateRecording(existingAiring.id, {
            start_time: startTime,
            end_time: endTime,
            title: program.title,
            program_title: program.title,
            content_key: program.content_key ?? null,
          });
          logger.info(`Rule "${rule.match_title}": moved pending recording ${existingAiring.id} to ${new Date(startTime).toISOString()}`);
        }
        continue;
      }

      if (!shouldIncludeRepeat(rule.repeat_policy, program.is_repeat, program.is_new)) continue;
      if (shouldSuppressContentDuplicate(rule.repeat_policy, program.content_key, recordedContentKeys)) continue;
      if (hasAcceptedOnceRecording) continue;

      // Legacy/id-less guide entries still get a narrow time-based duplicate guard.
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
      const inserted = insertRecordingForAiring({
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
        airing_key: airingKey,
        content_key: program.content_key ?? null,
        created_at: Date.now(),
      });
      if (inserted.id !== id) continue;
      if (rule.airing_policy === 'once') hasAcceptedOnceRecording = true;
      if (program.content_key) recordedContentKeys.add(program.content_key);
      logger.info(`Rule "${rule.match_title}": scheduled recording for "${program.title}" at ${new Date(startTime).toISOString()}`);
    }
  }
}

/** Clean up old recordings based on retention settings */
async function runCleanup(): Promise<void> {
  await enforceAllRuleRetentions();
  const retentionDays = parseInt(getConfig('recording_retention_days', '30'), 10);
  const maxDiskGb = parseInt(getConfig('recording_max_disk_gb', '50'), 10);

  // Age-based cleanup
  if (retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const old = getRecordings({ status: 'completed' }).filter(r => r.actual_end && r.actual_end < cutoff);
    for (const rec of old) {
      logger.info(`Cleanup: deleting recording ${rec.id} "${rec.title}" (age exceeded ${retentionDays}d retention)`);
      const deletedBytes = await deleteRecordingFile(rec.id);
      deleteRecording(rec.id);
      logger.info(`Cleanup: removed ${deletedBytes} bytes for recording ${rec.id}`);
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
        const deletedBytes = await deleteRecordingFile(rec.id);
        deleteRecording(rec.id);
        usage = getRecordingsDiskUsage();
        logger.info(`Cleanup: removed ${deletedBytes} bytes; disk usage is now ${(usage / 1e9).toFixed(1)}GB`);
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
