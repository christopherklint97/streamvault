import type {
  CreateRecordingRuleInput, RecordingCadenceMode, RecordingRepeatPolicy, RecordingRule, RecordingRuleMatchType,
} from '../types';

export interface RecordingRuleDraft {
  channelId: string;
  channelName: string;
  matchTitle: string;
  matchType: RecordingRuleMatchType;
  paddingBeforeMinutes: number;
  paddingAfterMinutes: number;
  repeatPolicy: RecordingRepeatPolicy;
  retentionLimit: string;
  maxRecordings: number;
  recordOnce: boolean;
  cadenceMode: RecordingCadenceMode;
  cadenceInterval: string;
  dailyStartTime: string;
  scheduleTimezone: string;
}

export function createRecordingRuleDraft(
  channel?: { id: string; name: string },
  matchTitle = '',
): RecordingRuleDraft {
  return {
    channelId: channel?.id ?? '',
    channelName: channel?.name ?? '',
    matchTitle,
    matchType: 'exact',
    paddingBeforeMinutes: 2,
    paddingAfterMinutes: 5,
    repeatPolicy: 'include_unknown',
    retentionLimit: '',
    maxRecordings: 0,
    recordOnce: false,
    cadenceMode: 'every',
    cadenceInterval: '2',
    dailyStartTime: '21:00',
    scheduleTimezone: 'Europe/Stockholm',
  };
}

export function minutesToRuleTime(minutes: number): string {
  const normalized = Number.isInteger(minutes) && minutes >= 0 && minutes < 24 * 60 ? minutes : 0;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

export function ruleTimeToMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Daily time must use HH:MM');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error('Daily time is invalid');
  return hours * 60 + minutes;
}

export function recordingRuleToDraft(rule: RecordingRule): RecordingRuleDraft {
  return {
    channelId: rule.channel_id,
    channelName: rule.channel_name,
    matchTitle: rule.match_title,
    matchType: rule.match_type,
    paddingBeforeMinutes: rule.padding_before / 60_000,
    paddingAfterMinutes: rule.padding_after / 60_000,
    repeatPolicy: rule.repeat_policy,
    retentionLimit: rule.retention_count > 0 ? String(rule.retention_count) : '',
    maxRecordings: rule.max_recordings,
    recordOnce: rule.airing_policy === 'once',
    cadenceMode: rule.cadence_mode,
    cadenceInterval: String(rule.cadence_interval),
    dailyStartTime: minutesToRuleTime(rule.daily_start_minutes),
    scheduleTimezone: rule.schedule_timezone,
  };
}

export function recordingRuleDraftToInput(draft: RecordingRuleDraft): CreateRecordingRuleInput {
  const matchTitle = draft.matchTitle.trim();
  if (!draft.channelId.trim()) throw new Error('Select a channel');
  if (!matchTitle) throw new Error('Program title is required');
  const paddingBefore = Number(draft.paddingBeforeMinutes);
  const paddingAfter = Number(draft.paddingAfterMinutes);
  if (!Number.isFinite(paddingBefore) || paddingBefore < 0 || !Number.isFinite(paddingAfter) || paddingAfter < 0) {
    throw new Error('Padding must be zero or more minutes');
  }
  const retentionLimit = draft.retentionLimit.trim() === '' ? 0 : Number(draft.retentionLimit);
  if (!draft.recordOnce && (!Number.isInteger(retentionLimit) || retentionLimit < 0)) {
    throw new Error('Keep latest must be a whole number or blank');
  }

  let cadenceMode = draft.recordOnce ? 'every' as const : draft.cadenceMode;
  let cadenceInterval = 1;
  let dailyStartMinutes = 0;
  if (cadenceMode === 'occurrence' || cadenceMode === 'hours') {
    cadenceInterval = Number(draft.cadenceInterval);
    const minimum = cadenceMode === 'occurrence' ? 2 : 1;
    if (!Number.isInteger(cadenceInterval) || cadenceInterval < minimum || cadenceInterval > 10_000) {
      throw new Error(cadenceMode === 'occurrence'
        ? 'Record every Nth value must be a whole number of 2 or more'
        : 'Minimum hours must be a whole number of 1 or more');
    }
  } else if (cadenceMode === 'daily') {
    dailyStartMinutes = ruleTimeToMinutes(draft.dailyStartTime);
  } else {
    cadenceMode = 'every';
  }

  return {
    channelId: draft.channelId,
    channelName: draft.channelName,
    matchTitle,
    matchType: draft.matchType,
    paddingBefore: Math.round(paddingBefore * 60_000),
    paddingAfter: Math.round(paddingAfter * 60_000),
    repeatPolicy: draft.repeatPolicy,
    retentionLimit: draft.recordOnce ? 0 : retentionLimit,
    maxRecordings: draft.maxRecordings,
    airingPolicy: draft.recordOnce ? 'once' : 'every',
    cadenceMode,
    cadenceInterval,
    dailyStartMinutes,
    ...(draft.scheduleTimezone ? { scheduleTimezone: draft.scheduleTimezone } : {}),
  };
}

export function ruleMatchesTitle(
  candidate: string,
  matchTitle: string,
  matchType: RecordingRuleMatchType,
): boolean {
  const normalizedCandidate = candidate.trim().toLocaleLowerCase();
  const normalizedMatch = matchTitle.trim().toLocaleLowerCase();
  if (!normalizedMatch) return false;
  if (matchType === 'exact') return normalizedCandidate === normalizedMatch;
  if (matchType === 'startsWith') return normalizedCandidate.startsWith(normalizedMatch);
  return normalizedCandidate.includes(normalizedMatch);
}

export function repeatPolicyDescription(policy: RecordingRepeatPolicy): string {
  if (policy === 'all') return 'Record every airing, including episodes marked as repeats.';
  if (policy === 'new_only') return 'Record only episodes explicitly marked as new.';
  return 'Record new episodes and episodes with unknown repeat status; skip confirmed repeats.';
}

export function repeatPolicyLabel(policy: RecordingRepeatPolicy): string {
  if (policy === 'all') return 'All airings';
  if (policy === 'new_only') return 'New only';
  return 'New and unknown';
}
