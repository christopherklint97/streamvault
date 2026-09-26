import {
  getRecordingsByStatus, getUpcomingRecordings, getEnabledRecordingRules,
  getProgramsByChannel, insertRecordingForAiring, getRecordings,
  deleteRecording, getConfig, getRecordingsByRuleId, getRecordingByAiringKey,
  getRecordingRule, updateRecording, saveProgramsForChannels,
  advanceRecordingRuleCadence, updateRecordingRuleCadenceProjection,
} from './db.js';
import type { DBProgram, DBRecordingRule } from './db.js';
import {
  startRecording, stopRecording, getActiveCount, getRecordingsDiskUsageAsync,
  deleteRecordingFile, enforceAllRuleRetentions, getRecordingMasterFilePath,
} from './recorder.js';
import { logger } from './logger.js';
import { randomUUID } from 'node:crypto';
import { buildAiringKey } from './epg-identity.js';
import {
  isAfterCadenceCursor, matchProgramTitle, projectNextCadenceAiring, shouldIncludeRepeat, shouldSuppressContentDuplicate,
} from './schedule-reconciliation.js';
import { fetchXtreamShortEpg, type XtreamConfig } from './xtream.js';
import { refreshRuleChannelPrograms } from './rule-epg-refresh.js';
import { createDiskUsageCache } from './recording-disk-usage.js';
import { getRecordingVodHlsState, removeAbandonedRecordingVodStaging, removeRecordingVodHlsCache } from './recording-vod-hls.js';
import { hasActiveRecordingVodViewer } from './recording-vod-routes.js';

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
const diskUsageCache = createDiskUsageCache(getRecordingsDiskUsageAsync, Date.now, 10_000,
  error => logger.warn(`Recording disk usage refresh failed: ${error instanceof Error ? error.message : error}`));

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

  // 2. Reconcile due rule-owned rows before any obsolete job can start.
  reconcileDueRuleSchedules(now);

  // 3. Start due jobs only after expired captures have released their slots.
  const scheduled = getRecordingsByStatus('scheduled');
  for (const rec of scheduled) {
    if (rec.start_time <= now) {
      if (rec.rule_id) {
        const currentRule = getRecordingRule(rec.rule_id);
        if (!currentRule || currentRule.enabled !== 1 ||
            (rec.rule_revision ?? 1) !== currentRule.rule_revision) continue;
      }
      logger.info(`Scheduler: starting recording ${rec.id} "${rec.title}"`);
      startRecording(rec.id).catch(err => {
        logger.error(`Scheduler: failed to start recording ${rec.id}: ${err}`);
      });
    }
  }

  // 4. Periodic rule matching (every hour)
  if (now - lastRuleCheck >= RULE_CHECK_INTERVAL) {
    lastRuleCheck = now;
    refreshRuleChannelsAndMatch();
  }

  // 5. Periodic cleanup (every hour)
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
  for (const rule of rules) reconcileRule(rule, false);
}

interface RuleCandidate {
  program: DBProgram;
  airingKey: string;
  startTime: number;
  recordingStart: number;
  recordingEnd: number;
}

function historyMatchesRule(recording: ReturnType<typeof getRecordingsByRuleId>[number], rule: DBRecordingRule): boolean {
  return recording.channel_id === rule.channel_id &&
    matchProgramTitle(recording.program_title ?? recording.title, rule.match_title, rule.match_type);
}

function reconcileEveryEligibleRule(
  rule: DBRecordingRule,
  candidates: RuleCandidate[],
  recordings: ReturnType<typeof getRecordingsByRuleId>,
  scheduled: ReturnType<typeof getRecordingsByRuleId>,
  knownProgramKeys: ReadonlySet<string>,
  cancelOrphans: boolean,
  now: number,
  retryStart: number | null,
  retryKey: string | null,
): void {
  const candidateKeys = new Set(candidates.map(candidate => candidate.airingKey));
  const retainedScheduled = scheduled.filter(recording =>
    Boolean(recording.airing_key && candidateKeys.has(recording.airing_key)));
  let used = recordings.filter(recording =>
    recording.status !== 'cancelled' && recording.status !== 'scheduled').length + retainedScheduled.length;
  const desired: RuleCandidate[] = [];
  for (const candidate of candidates) {
    const owned = recordings.some(recording =>
      recording.airing_key === candidate.airingKey && recording.status !== 'cancelled',
    );
    if (!owned && retryStart !== null && !isAfterCadenceCursor(candidate, retryStart, retryKey)) continue;
    if (!owned && rule.max_recordings > 0 && used >= rule.max_recordings) continue;
    desired.push(candidate);
    if (!owned) used += 1;
  }
  const desiredKeys = new Set(desired.map(candidate => candidate.airingKey));
  if (retryStart !== null) {
    for (const pending of scheduled) {
      if (!pending.airing_key) continue;
      const pendingAiring = {
        airingKey: pending.airing_key,
        startTime: pending.program_start_time ?? pending.start_time + rule.padding_before,
      };
      if (!isAfterCadenceCursor(pendingAiring, retryStart, retryKey)) desiredKeys.add(pending.airing_key);
    }
  }
  for (const pending of scheduled) {
    const knownObsolete = pending.channel_id !== rule.channel_id ||
      Boolean(pending.airing_key && knownProgramKeys.has(pending.airing_key));
    if (!desiredKeys.has(pending.airing_key ?? '') && (cancelOrphans || knownObsolete)) {
      updateRecording(pending.id, { status: 'cancelled', actual_end: now });
    }
  }
  for (const candidate of desired) {
    const existingAiring = getRecordingByAiringKey(candidate.airingKey);
    if (existingAiring) {
      if (existingAiring.rule_id === rule.id && existingAiring.status === 'scheduled') {
        updateRecording(existingAiring.id, {
          start_time: candidate.recordingStart,
          end_time: candidate.recordingEnd,
          title: candidate.program.title,
          program_title: candidate.program.title,
          program_start_time: candidate.program.start_time,
          program_stop_time: candidate.program.stop_time,
          rule_revision: rule.rule_revision,
          cadence_slot: null,
          content_key: candidate.program.content_key ?? null,
        });
      }
      continue;
    }
    const existing = getUpcomingRecordings(candidate.recordingStart - 60_000, candidate.recordingEnd + 60_000);
    if (existing.some(recording =>
      recording.channel_id === rule.channel_id && Math.abs(recording.start_time - candidate.recordingStart) < 120_000
    )) continue;
    const id = randomUUID();
    const inserted = insertRecordingForAiring({
      id, channel_id: rule.channel_id, channel_name: rule.channel_name,
      title: candidate.program.title, status: 'scheduled',
      start_time: candidate.recordingStart, end_time: candidate.recordingEnd,
      actual_start: null, actual_end: null, file_path: null, file_size: 0, duration: 0, error: null,
      rule_id: rule.id, rule_revision: rule.rule_revision, cadence_slot: null,
      program_title: candidate.program.title, program_start_time: candidate.program.start_time,
      program_stop_time: candidate.program.stop_time, airing_key: candidate.airingKey,
      content_key: candidate.program.content_key ?? null, created_at: now,
    });
    if (inserted.id === id) {
      logger.info(`Rule "${rule.match_title}": scheduled recording for "${candidate.program.title}" at ${new Date(candidate.recordingStart).toISOString()}`);
    }
  }
}

function cancelPendingRecording(recording: ReturnType<typeof getRecordingsByRuleId>[number], now: number): void {
  if (recording.status !== 'scheduled') return;
  updateRecording(recording.id, { status: 'cancelled', actual_end: now });
}

function persistOccurrenceProjection(
  rule: DBRecordingRule,
  projection: ReturnType<typeof projectNextCadenceAiring<RuleCandidate>>,
): void {
  if (rule.cadence_mode !== 'occurrence') return;
  updateRecordingRuleCadenceProjection(rule.id, rule.rule_revision, {
    cadence_occurrence_progress: projection.occurrenceProgress,
    cadence_cursor_start: projection.cursorStart,
    cadence_cursor_key: projection.cursorKey,
  });
}

function reconcileRule(rule: DBRecordingRule, cancelOrphans: boolean): void {
  const now = Date.now();
  const programs = getProgramsByChannel(rule.channel_id, now);
  const knownProgramKeys = new Set<string>();
  const recordings = getRecordingsByRuleId(rule.id);
  const scheduled = recordings.filter(recording => recording.status === 'scheduled');
  const history = recordings.filter(recording =>
    recording.status !== 'scheduled' && historyMatchesRule(recording, rule) &&
    (recording.rule_revision ?? 1) === rule.rule_revision,
  );
  const active = recordings.filter(recording => ['recording', 'finalizing'].includes(recording.status));
  const acceptedContentKeys = new Set(recordings
    .filter(recording => recording.status === 'completed' && historyMatchesRule(recording, rule) && recording.content_key)
    .map(recording => recording.content_key!));
  const candidateContentKeys = new Set<string>();
  const candidates: RuleCandidate[] = [];

  for (const program of programs) {
    const airingKey = program.airing_key ?? buildAiringKey(
      program.source ?? 'legacy', program.channel_id, program.provider_event_id, program.start_time, program.stop_time,
    );
    knownProgramKeys.add(airingKey);
    if (!matchProgramTitle(program.title, rule.match_title, rule.match_type)) continue;
    if (!shouldIncludeRepeat(rule.repeat_policy, program.is_repeat, program.is_new)) continue;
    if (shouldSuppressContentDuplicate(rule.repeat_policy, program.content_key, acceptedContentKeys)) continue;
    if (shouldSuppressContentDuplicate(rule.repeat_policy, program.content_key, candidateContentKeys)) continue;
    if (program.content_key && rule.repeat_policy !== 'all') candidateContentKeys.add(program.content_key);
    candidates.push({
      program,
      airingKey,
      startTime: program.start_time,
      recordingStart: program.start_time - rule.padding_before,
      recordingEnd: program.stop_time + rule.padding_after,
    });
  }

  if (rule.airing_policy === 'every' && rule.cadence_mode === 'every') {
    reconcileEveryEligibleRule(
      rule, candidates, recordings, scheduled, knownProgramKeys, cancelOrphans, now,
      rule.cadence_retry_start, rule.cadence_retry_key,
    );
    return;
  }

  // An active writer/finalizer is the rule's sole outstanding attempt.
  if (active.length > 0) {
    for (const pending of scheduled) cancelPendingRecording(pending, now);
    return;
  }

  let lastSuccessStart = rule.cadence_last_success_start;
  if (lastSuccessStart === null) {
    const latestCompleted = history
      .filter(recording => recording.status === 'completed')
      .sort((left, right) => {
        const leftStart = left.program_start_time ?? left.start_time + rule.padding_before;
        const rightStart = right.program_start_time ?? right.start_time + rule.padding_before;
        return rightStart - leftStart || (right.airing_key ?? '').localeCompare(left.airing_key ?? '');
      })[0];
    if (latestCompleted) {
      lastSuccessStart = latestCompleted.program_start_time ?? latestCompleted.start_time + rule.padding_before;
      advanceRecordingRuleCadence(rule.id, rule.rule_revision, lastSuccessStart, latestCompleted.airing_key ?? null);
    }
  }

  const currentScheduled = scheduled.filter(recording => (recording.rule_revision ?? 1) === rule.rule_revision);
  const hasRejectedSinceSuccess = history.some(recording =>
    ['failed', 'cancelled'].includes(recording.status) &&
    (lastSuccessStart === null ||
      (recording.program_start_time ?? recording.start_time + rule.padding_before) > lastSuccessStart));

  // Preserve a valid current-revision reservation instead of re-projecting after
  // already-counted guide rows have fallen out of the cache.
  if (currentScheduled.length === 1 && (rule.airing_policy !== 'once' || lastSuccessStart === null) &&
      rule.cadence_retry_start === null && !hasRejectedSinceSuccess) {
    const pending = currentScheduled[0];
    const candidate = candidates.find(item => item.airingKey === pending.airing_key);
    if (candidate) {
      if (pending.start_time !== candidate.recordingStart || pending.end_time !== candidate.recordingEnd ||
          pending.title !== candidate.program.title || pending.cadence_slot !== 1) {
        updateRecording(pending.id, {
          start_time: candidate.recordingStart,
          end_time: candidate.recordingEnd,
          title: candidate.program.title,
          program_title: candidate.program.title,
          program_start_time: candidate.program.start_time,
          program_stop_time: candidate.program.stop_time,
          rule_revision: rule.rule_revision,
          cadence_slot: 1,
          content_key: candidate.program.content_key ?? null,
        });
      }
      for (const obsolete of scheduled.filter(item => item.id !== pending.id)) cancelPendingRecording(obsolete, now);
      return;
    }
    if (!cancelOrphans && (!pending.airing_key || !knownProgramKeys.has(pending.airing_key))) return;
  }

  const cadenceHistory = history
    .filter(recording => recording.airing_key)
    .map(recording => ({
      airingKey: recording.airing_key!,
      startTime: recording.program_start_time ?? recording.start_time + rule.padding_before,
      status: recording.status,
    }));
  const projection = projectNextCadenceAiring(candidates, cadenceHistory, {
    mode: rule.cadence_mode,
    interval: rule.cadence_interval,
    dailyStartMinutes: rule.daily_start_minutes,
    lastSuccessStart,
    timeZone: rule.schedule_timezone,
    occurrenceProgress: rule.cadence_occurrence_progress,
    cursorStart: rule.cadence_cursor_start,
    cursorKey: rule.cadence_cursor_key,
    retryAfterStart: rule.cadence_retry_start,
    retryAfterKey: rule.cadence_retry_key,
  });
  let desired = rule.airing_policy === 'once'
    ? (lastSuccessStart !== null ? undefined : projection.airing)
    : projection.airing;

  if (desired && rule.max_recordings > 0) {
    const used = recordings.filter(recording => recording.status !== 'cancelled' && recording.status !== 'scheduled').length;
    if (used >= rule.max_recordings) desired = undefined;
  }
  const desiredKey = desired?.airingKey ?? null;
  for (const pending of scheduled) {
    if (pending.airing_key !== desiredKey) {
      cancelPendingRecording(pending, now);
      logger.info(`Rule "${rule.match_title}": cancelled obsolete pending recording ${pending.id}`);
    }
  }
  if (!desired) {
    persistOccurrenceProjection(rule, projection);
    return;
  }

  const existingAiring = getRecordingByAiringKey(desired.airingKey);
  if (existingAiring) {
    if (existingAiring.status === 'scheduled' && existingAiring.rule_id === rule.id) {
      updateRecording(existingAiring.id, {
        start_time: desired.recordingStart,
        end_time: desired.recordingEnd,
        title: desired.program.title,
        program_title: desired.program.title,
        program_start_time: desired.program.start_time,
        program_stop_time: desired.program.stop_time,
        rule_revision: rule.rule_revision,
        cadence_slot: 1,
        content_key: desired.program.content_key ?? null,
      });
      persistOccurrenceProjection(rule, projection);
    }
    return;
  }

  const existing = getUpcomingRecordings(desired.recordingStart - 60_000, desired.recordingEnd + 60_000);
  const isDuplicate = existing.some(recording =>
    recording.channel_id === rule.channel_id && Math.abs(recording.start_time - desired.recordingStart) < 120_000
  );
  if (isDuplicate) return;

  const id = randomUUID();
  const inserted = insertRecordingForAiring({
    id,
    channel_id: rule.channel_id,
    channel_name: rule.channel_name,
    title: desired.program.title,
    status: 'scheduled',
    start_time: desired.recordingStart,
    end_time: desired.recordingEnd,
    actual_start: null,
    actual_end: null,
    file_path: null,
    file_size: 0,
    duration: 0,
    error: null,
    rule_id: rule.id,
    rule_revision: rule.rule_revision,
    cadence_slot: 1,
    program_title: desired.program.title,
    program_start_time: desired.program.start_time,
    program_stop_time: desired.program.stop_time,
    airing_key: desired.airingKey,
    content_key: desired.program.content_key ?? null,
    created_at: now,
  });
  if (inserted.id === id) {
    persistOccurrenceProjection(rule, projection);
    logger.info(`Rule "${rule.match_title}": scheduled recording for "${desired.program.title}" at ${new Date(desired.recordingStart).toISOString()}`);
  }
}

/** Cancel or adopt stale rule-owned rows before capture startup, including after a crash. */
export function reconcileDueRuleSchedules(now = Date.now()): void {
  const reconciledRules = new Set<string>();
  for (const recording of getRecordingsByStatus('scheduled')) {
    if (!recording.rule_id) continue;
    const rule = getRecordingRule(recording.rule_id);
    if (!rule || rule.enabled !== 1) {
      updateRecording(recording.id, { status: 'cancelled', actual_end: now });
      continue;
    }
    if ((recording.rule_revision ?? 1) !== rule.rule_revision && !reconciledRules.has(rule.id)) {
      reconciledRules.add(rule.id);
      reconcileRule(rule, false);
    }
  }
}

/** Reconcile one edited rule, including cancelling schedules no longer selected. */
export function reconcileRecordingRule(ruleId: string): void {
  const rule = getRecordingRule(ruleId);
  if (!rule || rule.enabled !== 1) {
    const now = Date.now();
    for (const recording of getRecordingsByRuleId(ruleId).filter(item => item.status === 'scheduled')) {
      cancelPendingRecording(recording, now);
    }
    return;
  }
  reconcileRule(rule, true);
}

/** Clean up old recordings based on retention settings */
export async function runCleanup(): Promise<void> {
  await enforceAllRuleRetentions();
  for (const rec of getRecordings({ status: 'completed' })) {
    const master = getRecordingMasterFilePath(rec.id);
    if (master) await removeAbandonedRecordingVodStaging(master);
  }
  const retentionDays = parseInt(getConfig('recording_retention_days', '30'), 10);
  const maxDiskGb = parseInt(getConfig('recording_max_disk_gb', '50'), 10);

  // Age-based cleanup
  if (retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const old = getRecordings({ status: 'completed' }).filter(r => r.actual_end && r.actual_end < cutoff);
    for (const rec of old) {
      if (hasActiveRecordingVodViewer(rec.id)) continue;
      logger.info(`Cleanup: deleting recording ${rec.id} "${rec.title}" (age exceeded ${retentionDays}d retention)`);
      const deletedBytes = await deleteRecordingFile(rec.id);
      deleteRecording(rec.id);
      logger.info(`Cleanup: removed ${deletedBytes} bytes for recording ${rec.id}`);
    }
  }

  // Disk-based cleanup
  if (maxDiskGb > 0) {
    const maxBytes = maxDiskGb * 1_073_741_824;
    let usage = await getRecordingsDiskUsageAsync();
    if (usage > maxBytes) {
      const completed = getRecordings({ status: 'completed' });
      completed.sort((a, b) => (a.actual_end ?? 0) - (b.actual_end ?? 0));
      // Disposable seek packages are reclaimed before permanent masters. Do not
      // evict a package while a native player still holds a session for it.
      for (const rec of completed) {
        if (usage <= maxBytes) break;
        if (hasActiveRecordingVodViewer(rec.id)) continue;
        const master = getRecordingMasterFilePath(rec.id);
        if (!master || await getRecordingVodHlsState(master) !== 'ready') continue;
        await removeRecordingVodHlsCache(master);
        usage = await getRecordingsDiskUsageAsync();
        logger.info(`Cleanup: reclaimed seekable cache for recording ${rec.id}; disk usage is now ${(usage / 1e9).toFixed(1)}GB`);
      }
      // If disposable renditions cannot bring usage below the limit, delete
      // oldest completed recordings as before.
      for (const rec of completed) {
        if (usage <= maxBytes) break;
        if (hasActiveRecordingVodViewer(rec.id)) continue;
        logger.info(`Cleanup: deleting recording ${rec.id} "${rec.title}" (disk usage ${(usage / 1e9).toFixed(1)}GB > ${maxDiskGb}GB limit)`);
        const deletedBytes = await deleteRecordingFile(rec.id);
        deleteRecording(rec.id);
        usage = await getRecordingsDiskUsageAsync();
        logger.info(`Cleanup: removed ${deletedBytes} bytes; disk usage is now ${(usage / 1e9).toFixed(1)}GB`);
      }
      if (usage > maxBytes) logger.warn(`Cleanup: recording disk usage still exceeds ${maxDiskGb}GB; preserving actively viewed recordings`);
    }
  }
}

/** Get scheduler status for the API */
export function getSchedulerStatus(): { activeCount: number; diskUsageBytes: number; schedulerRunning: boolean } {
  return {
    activeCount: getActiveCount(),
    diskUsageBytes: diskUsageCache.get(),
    schedulerRunning: tickTimer !== null,
  };
}
