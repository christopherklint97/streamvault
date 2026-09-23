import type { DBRecording, DBRecordingRule } from './db.js';
import type { CommercialSegmentWrite, DBCommercialSegment } from './commercial-store.js';
import { buildAiringKey } from './epg-identity.js';
import { validateCommercialIntervals } from './commercial-intervals.js';

export type CommercialAnalysisStatus =
  | 'not_analyzed'
  | 'queued'
  | 'analyzing'
  | 'review_needed'
  | 'ready'
  | 'failed';

const analysisStates = new Set<CommercialAnalysisStatus>([
  'not_analyzed', 'queued', 'analyzing', 'review_needed', 'ready', 'failed',
]);
const reviewStates = new Set(['suggested', 'accepted', 'rejected']);

export function normalizeCommercialAnalysisStatus(value: string | null | undefined): CommercialAnalysisStatus {
  if (!value || value === 'not_requested') return 'not_analyzed';
  return analysisStates.has(value as CommercialAnalysisStatus)
    ? value as CommercialAnalysisStatus
    : 'failed';
}

function overrideValue(value: number | null | undefined): boolean | null {
  return value === null || value === undefined ? null : value === 1;
}

export function mapRecordingForApi(recording: DBRecording) {
  return {
    ...recording,
    master_path: recording.master_file_path ?? null,
    commercial_analysis_status: normalizeCommercialAnalysisStatus(recording.analysis_state),
    commercial_analysis_error: recording.analysis_error ?? null,
    commercial_segment_count: recording.commercial_segment_count ?? 0,
    commercial_total_seconds: recording.commercial_seconds ?? 0,
    commercial_skip_override: overrideValue(recording.commercial_skip_override),
  };
}

function segmentSource(detector: string): string {
  return detector === 'comskip' ? 'detector' : detector;
}

export function mapCommercialSegmentsResponse(
  recording: DBRecording,
  segments: DBCommercialSegment[],
  globalAutoSkip: boolean,
) {
  const override = overrideValue(recording.commercial_skip_override);
  return {
    analysis: {
      status: normalizeCommercialAnalysisStatus(recording.analysis_state),
      error: recording.analysis_error ?? null,
      detector: segments[0]?.detector ?? (recording.analysis_profile ? 'comskip' : null),
      profileVersion: recording.analysis_profile ?? null,
    },
    segments: segments.map(segment => ({
      id: String(segment.id),
      startSeconds: segment.start_seconds,
      endSeconds: segment.end_seconds,
      source: segmentSource(segment.detector),
      confidence: segment.confidence,
      state: segment.review_state,
      detectorVersion: segment.detector_version,
      profileVersion: recording.analysis_profile ?? undefined,
    })),
    autoSkipOverride: override,
    effectiveAutoSkip: override ?? globalAutoSkip,
  };
}

interface SegmentRequest {
  startSeconds?: unknown;
  endSeconds?: unknown;
  source?: unknown;
  confidence?: unknown;
  state?: unknown;
  detectorVersion?: unknown;
}

export function validateCommercialSegmentReplacement(value: unknown, durationSeconds: number): CommercialSegmentWrite[] {
  if (!Array.isArray(value)) throw new Error('segments must be an array');
  if (value.length > 1000) throw new Error('too many segments (maximum 1000)');
  const converted = value.map((entry, index): CommercialSegmentWrite => {
    if (!entry || typeof entry !== 'object') throw new Error(`segment ${index} must be an object`);
    const candidate = entry as SegmentRequest;
    if (typeof candidate.startSeconds !== 'number' || typeof candidate.endSeconds !== 'number') {
      throw new Error(`segment ${index} boundaries must be numbers`);
    }
    if (typeof candidate.state !== 'string' || !reviewStates.has(candidate.state)) {
      throw new Error(`segment ${index} state is invalid`);
    }
    if (typeof candidate.source !== 'string' || !candidate.source.trim()) {
      throw new Error(`segment ${index} source is required`);
    }
    const confidence = candidate.confidence === undefined || candidate.confidence === null
      ? null
      : candidate.confidence;
    if (confidence !== null &&
        (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new Error(`segment ${index} confidence must be between 0 and 1`);
    }
    const detector = candidate.source === 'detector' ? 'comskip' : candidate.source;
    const detectorVersion = detector === 'manual'
      ? 'manual-v1'
      : typeof candidate.detectorVersion === 'string' ? candidate.detectorVersion : '';
    return {
      startSeconds: candidate.startSeconds,
      endSeconds: candidate.endSeconds,
      detector,
      confidence,
      detectorVersion,
      reviewState: candidate.state,
    };
  });
  return validateCommercialIntervals(converted, durationSeconds);
}

export interface ProgramAiringIdentity {
  airing_key?: string | null;
  source?: string;
  channel_id: string;
  provider_event_id?: string | null;
  start_time: number;
  stop_time: number;
}

export function deriveProgramAiringKey(program: ProgramAiringIdentity): string {
  return program.airing_key ?? buildAiringKey(
    program.source ?? 'legacy',
    program.channel_id,
    program.provider_event_id,
    program.start_time,
    program.stop_time,
  );
}

export function validateFromProgramLookup(value: unknown):
  | { kind: 'airingKey'; airingKey: string }
  | { kind: 'legacy'; channelId: string; programStart: number; programStop: number } {
  if (!value || typeof value !== 'object') throw new Error('request body is required');
  const body = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(body, 'airingKey')) {
    if (typeof body.airingKey !== 'string' || !body.airingKey.trim()) {
      throw new Error('airingKey must be a non-empty string');
    }
    return { kind: 'airingKey', airingKey: body.airingKey };
  }
  if (typeof body.channelId !== 'string' || !body.channelId.trim()) {
    throw new Error('channelId is required for legacy program lookup');
  }
  if (typeof body.programStart !== 'number' || !Number.isFinite(body.programStart)) {
    throw new Error('programStart must be finite');
  }
  if (typeof body.programStop !== 'number' || !Number.isFinite(body.programStop) || body.programStop <= body.programStart) {
    throw new Error('programStop must be finite and greater than programStart');
  }
  return {
    kind: 'legacy',
    channelId: body.channelId,
    programStart: body.programStart,
    programStop: body.programStop,
  };
}

export function validateCommercialSkipOverride(value: unknown): boolean | null {
  if (value === null || typeof value === 'boolean') return value;
  throw new Error('enabled must be a boolean or null');
}

export function parseBooleanConfig(value: string, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

const MATCH_TYPES = new Set(['contains', 'exact', 'startsWith']);
const REPEAT_POLICIES = new Set(['all', 'include_unknown', 'new_only']);
const AIRING_POLICIES = new Set(['every', 'once']);
const CADENCE_MODES = new Set(['every', 'occurrence', 'hours', 'daily']);
const MAX_RULE_PADDING_MS = 24 * 60 * 60_000;
type EffectiveCadence = Pick<DBRecordingRule,
  'airing_policy' | 'cadence_mode' | 'cadence_interval' | 'daily_start_minutes' | 'schedule_timezone'>;

function canonicalizeEffectiveCadence(rule: EffectiveCadence): EffectiveCadence {
  const scheduleTimezone = validatedTimeZone(rule.schedule_timezone);
  if (rule.airing_policy === 'once') {
    return {
      ...rule,
      cadence_mode: 'every',
      cadence_interval: 1,
      daily_start_minutes: 0,
      schedule_timezone: scheduleTimezone,
    };
  }
  if (rule.cadence_mode === 'occurrence') {
    if (rule.cadence_interval < 2) throw new Error('cadenceInterval must be at least 2 for occurrence mode');
    return { ...rule, daily_start_minutes: 0, schedule_timezone: scheduleTimezone };
  }
  if (rule.cadence_mode === 'hours') {
    if (rule.cadence_interval < 1) throw new Error('cadenceInterval must be at least 1 for hours mode');
    return { ...rule, daily_start_minutes: 0, schedule_timezone: scheduleTimezone };
  }
  if (rule.cadence_mode === 'daily') {
    if (rule.daily_start_minutes < 0 || rule.daily_start_minutes > 1439) {
      throw new Error('dailyStartMinutes must be between 0 and 1439 for daily mode');
    }
    return { ...rule, cadence_interval: 1, schedule_timezone: scheduleTimezone };
  }
  return {
    ...rule,
    cadence_mode: 'every',
    cadence_interval: 1,
    daily_start_minutes: 0,
    schedule_timezone: scheduleTimezone,
  };
}

function normalizedMatchTitle(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function schedulingSemantics(rule: DBRecordingRule): Record<string, unknown> {
  const cadence = canonicalizeEffectiveCadence(rule);
  return {
    channel_id: rule.channel_id,
    match_title: normalizedMatchTitle(rule.match_title),
    match_type: rule.match_type,

    airing_policy: cadence.airing_policy,
    repeat_policy: rule.repeat_policy,
    cadence_mode: cadence.cadence_mode,
    cadence_interval: cadence.cadence_interval,
    daily_start_minutes: cadence.daily_start_minutes,
    schedule_timezone: cadence.cadence_mode === 'daily' ? cadence.schedule_timezone : '',
  };
}

export function versionRecordingRuleUpdates<T extends Record<string, unknown>>(
  current: DBRecordingRule,
  updates: T,
): T & Partial<Pick<DBRecordingRule,
  'rule_revision' | 'cadence_last_success_start' | 'cadence_last_success_key' |
  'cadence_occurrence_progress' | 'cadence_cursor_start' | 'cadence_cursor_key' |
  'cadence_retry_start' | 'cadence_retry_key'>> {
  const cadenceTouched = ['airing_policy', 'cadence_mode', 'cadence_interval', 'daily_start_minutes', 'schedule_timezone']
    .some(field => Object.prototype.hasOwnProperty.call(updates, field));
  const effective = { ...current, ...updates } as DBRecordingRule;
  const canonicalCadence = canonicalizeEffectiveCadence(effective);
  const canonicalUpdates = { ...updates } as T & Partial<DBRecordingRule>;
  if (cadenceTouched) Object.assign(canonicalUpdates, {
    cadence_mode: canonicalCadence.cadence_mode,
    cadence_interval: canonicalCadence.cadence_interval,
    daily_start_minutes: canonicalCadence.daily_start_minutes,
  });

  const before = schedulingSemantics(current);
  const after = schedulingSemantics({ ...current, ...canonicalUpdates } as DBRecordingRule);
  const changed = Object.keys(before).filter(field => before[field] !== after[field]);
  if (changed.length === 0) return canonicalUpdates;

  const versioned = {
    ...canonicalUpdates,
    rule_revision: current.rule_revision + 1,
  } as T & Partial<DBRecordingRule>;
  const preservesAcceptedSuccess = current.airing_policy === 'every' &&
    after.airing_policy === 'once' &&
    current.cadence_last_success_start !== null &&
    changed.every(field => [
      'airing_policy', 'cadence_mode', 'cadence_interval', 'daily_start_minutes', 'schedule_timezone',
    ].includes(field));
  Object.assign(versioned, {
    cadence_last_success_start: preservesAcceptedSuccess ? current.cadence_last_success_start : null,
    cadence_last_success_key: preservesAcceptedSuccess ? current.cadence_last_success_key : null,
    cadence_occurrence_progress: 0,
    cadence_cursor_start: preservesAcceptedSuccess ? current.cadence_last_success_start : null,
    cadence_cursor_key: preservesAcceptedSuccess ? current.cadence_last_success_key : null,
    cadence_retry_start: null,
    cadence_retry_key: null,
  });
  return versioned;
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`${name} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value.trim();
}

export interface ValidatedRecordingRulePayload {
  channel_id?: string;
  channel_name?: string;
  match_title?: string;
  match_type?: string;
  repeat_policy?: string;
  enabled?: number;
  padding_before?: number;
  padding_after?: number;
  max_recordings?: number;
  retention_count?: number;
  airing_policy?: 'every' | 'once';
  cadence_mode?: 'every' | 'occurrence' | 'hours' | 'daily';
  cadence_interval?: number;
  daily_start_minutes?: number;
  schedule_timezone?: string;
}

function validatedTimeZone(value: unknown): string {
  const timeZone = boundedText(value, 'scheduleTimezone', 100);
  if (timeZone !== 'UTC' && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(timeZone)) {
    throw new Error('scheduleTimezone must be an IANA timezone');
  }
  try {
    return new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new Error('scheduleTimezone is invalid');
  }
}

export function validateRecordingRulePayload(value: unknown, partial: boolean): ValidatedRecordingRulePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body is required');
  const body = value as Record<string, unknown>;
  const output: ValidatedRecordingRulePayload = {};
  if (!partial || body.channelId !== undefined) output.channel_id = boundedText(body.channelId, 'channelId', 512);
  if (!partial || body.matchTitle !== undefined) output.match_title = boundedText(body.matchTitle, 'matchTitle', 500);
  if (body.channelName !== undefined) output.channel_name = boundedText(body.channelName, 'channelName', 500);
  else if (!partial) output.channel_name = output.channel_id;

  const matchType = body.matchType ?? (partial ? undefined : 'contains');
  if (matchType !== undefined) {
    if (typeof matchType !== 'string' || !MATCH_TYPES.has(matchType)) throw new Error('matchType is invalid');
    output.match_type = matchType;
  }
  const repeatPolicy = body.repeatPolicy ?? (partial ? undefined : 'include_unknown');
  if (repeatPolicy !== undefined) {
    if (typeof repeatPolicy !== 'string' || !REPEAT_POLICIES.has(repeatPolicy)) throw new Error('repeatPolicy is invalid');
    output.repeat_policy = repeatPolicy;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    output.enabled = body.enabled ? 1 : 0;
  }
  if (!partial || body.paddingBefore !== undefined) {
    output.padding_before = boundedInteger(body.paddingBefore ?? 120_000, 'paddingBefore', 0, MAX_RULE_PADDING_MS);
  }
  if (!partial || body.paddingAfter !== undefined) {
    output.padding_after = boundedInteger(body.paddingAfter ?? 300_000, 'paddingAfter', 0, MAX_RULE_PADDING_MS);
  }
  if (!partial || body.maxRecordings !== undefined) {
    output.max_recordings = boundedInteger(body.maxRecordings ?? 0, 'maxRecordings', 0, 10_000);
  }
  if (!partial || body.retentionLimit !== undefined) {
    output.retention_count = boundedInteger(body.retentionLimit ?? 0, 'retentionLimit', 0, 10_000);
  }
  const airingPolicy = body.airingPolicy ?? (partial ? undefined : 'every');
  if (airingPolicy !== undefined) {
    if (typeof airingPolicy !== 'string' || !AIRING_POLICIES.has(airingPolicy)) throw new Error('airingPolicy is invalid');
    output.airing_policy = airingPolicy as 'every' | 'once';
  }
  const cadenceMode = body.cadenceMode ?? (partial ? undefined : 'every');
  if (cadenceMode !== undefined) {
    if (typeof cadenceMode !== 'string' || !CADENCE_MODES.has(cadenceMode)) throw new Error('cadenceMode is invalid');
    output.cadence_mode = cadenceMode as 'every' | 'occurrence' | 'hours' | 'daily';
  }
  if (!partial || body.cadenceInterval !== undefined) {
    output.cadence_interval = boundedInteger(body.cadenceInterval ?? 1, 'cadenceInterval', 1, 10_000);
  }
  if (!partial || body.dailyStartMinutes !== undefined) {
    output.daily_start_minutes = boundedInteger(body.dailyStartMinutes ?? 0, 'dailyStartMinutes', 0, 1439);
  }
  if (!partial || body.scheduleTimezone !== undefined) {
    output.schedule_timezone = validatedTimeZone(body.scheduleTimezone ?? 'Europe/Stockholm');
  }
  if (!partial) {
    Object.assign(output, canonicalizeEffectiveCadence({
      airing_policy: output.airing_policy!,
      cadence_mode: output.cadence_mode!,
      cadence_interval: output.cadence_interval!,
      daily_start_minutes: output.daily_start_minutes!,
      schedule_timezone: output.schedule_timezone!,
    }));
  }
  return output;
}
