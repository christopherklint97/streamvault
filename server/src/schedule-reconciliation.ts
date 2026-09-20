export type RuleMatchType = 'exact' | 'contains' | 'startsWith';
export type RepeatPolicy = 'all' | 'include_unknown' | 'new_only';

export function shouldIncludeRepeat(
  policy: RepeatPolicy | string | undefined,
  isRepeat: number | null | undefined,
  isNew: number | null | undefined = null,
): boolean {
  switch (policy ?? 'include_unknown') {
    case 'all': return true;
    case 'include_unknown': return isRepeat !== 1;
    case 'new_only': return isRepeat === 0 || (isRepeat == null && isNew === 1);
    default: return false;
  }
}

export function shouldSuppressContentDuplicate(
  policy: RepeatPolicy | string | undefined,
  contentKey: string | null | undefined,
  existingContentKeys: ReadonlySet<string>,
): boolean {
  return policy !== 'all' && Boolean(contentKey && existingContentKeys.has(contentKey));
}

function normalizeTitle(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function matchProgramTitle(title: string, matchTitle: string, matchType: string): boolean {
  const candidate = normalizeTitle(title);
  const requested = normalizeTitle(matchTitle);
  if (!requested) return false;
  switch (matchType) {
    case 'exact': return candidate === requested;
    case 'startsWith': return candidate.startsWith(requested);
    case 'contains': return candidate.includes(requested);
    default: return false;
  }
}

export interface ScheduledAiring {
  id: string;
  airingKey: string;
  status: string;
  startTime: number;
  endTime: number;
}

export interface GuideAiring {
  airingKey: string;
  startTime: number;
  endTime: number;
}

export interface ReconciliationResult {
  updates: Array<{ id: string; startTime: number; endTime: number }>;
  creates: GuideAiring[];
}

/** Active/non-scheduled captures are immutable; only pending jobs move. */
export function reconcileScheduledAirings(
  existing: ScheduledAiring[],
  guide: GuideAiring[],
): ReconciliationResult {
  const byKey = new Map(existing.map(item => [item.airingKey, item]));
  const updates: ReconciliationResult['updates'] = [];
  const creates: GuideAiring[] = [];
  for (const airing of guide) {
    const current = byKey.get(airing.airingKey);
    if (!current) {
      creates.push(airing);
      continue;
    }
    if (current.status === 'scheduled' &&
        (current.startTime !== airing.startTime || current.endTime !== airing.endTime)) {
      updates.push({ id: current.id, startTime: airing.startTime, endTime: airing.endTime });
    }
  }
  return { updates, creates };
}
