import type { RecordingRepeatPolicy, RecordingRuleMatchType } from '../types';

export interface RecordingRuleDraft {
  channelId: string;
  channelName: string;
  matchTitle: string;
  matchType: RecordingRuleMatchType;
  paddingBeforeMinutes: number;
  paddingAfterMinutes: number;
  repeatPolicy: RecordingRepeatPolicy;
  maxRecordings: string;
  recordOnce: boolean;
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
    maxRecordings: '',
    recordOnce: false,
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
