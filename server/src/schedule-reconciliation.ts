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

export type CadenceMode = 'every' | 'occurrence' | 'hours' | 'daily';

export interface CadenceAiring {
  airingKey: string;
  startTime: number;
}

export interface CadenceHistoryEntry extends CadenceAiring {
  status: string;
}

export interface CadenceSettings {
  mode: CadenceMode;
  interval: number;
  dailyStartMinutes: number;
  lastSuccessStart: number | null;
  timeZone: string;
  occurrenceProgress?: number;
  cursorStart?: number | null;
  cursorKey?: string | null;
  retryAfterStart?: number | null;
  retryAfterKey?: string | null;
}

export interface CadenceProjection<T extends CadenceAiring> {
  airing: T | undefined;
  occurrenceProgress: number;
  cursorStart: number | null;
  cursorKey: string | null;
}

const datePartFormatters = new Map<string, Intl.DateTimeFormat>();

function localDayAndMinute(timestamp: number, timeZone: string): { day: string; minute: number } {
  let formatter = datePartFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    datePartFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function isAfterCadenceCursor(item: CadenceAiring, start: number | null, key: string | null): boolean {
  if (start === null) return true;
  if (item.startTime !== start) return item.startTime > start;
  return item.airingKey > (key ?? '');
}

/** Project the next reservation and durable occurrence cursor. */
export function projectNextCadenceAiring<T extends CadenceAiring>(
  candidates: T[],
  history: CadenceHistoryEntry[],
  settings: CadenceSettings,
): CadenceProjection<T> {
  const attemptedKeys = new Set(history.map(item => item.airingKey));
  const latestRejected = history
    .filter(item => ['failed', 'cancelled'].includes(item.status) &&
      (settings.lastSuccessStart === null || item.startTime > settings.lastSuccessStart))
    .sort((left, right) => left.startTime - right.startTime || left.airingKey.localeCompare(right.airingKey))
    .at(-1);
  const retryStart = settings.retryAfterStart ?? latestRejected?.startTime ?? null;
  const retryKey = settings.retryAfterKey ?? latestRejected?.airingKey ?? null;
  const sorted = candidates
    .filter(item => !attemptedKeys.has(item.airingKey) && isAfterCadenceCursor(item, retryStart, retryKey))
    .slice()
    .sort((left, right) => left.startTime - right.startTime || left.airingKey.localeCompare(right.airingKey));
  const unchanged = {
    occurrenceProgress: settings.occurrenceProgress ?? 0,
    cursorStart: settings.cursorStart ?? null,
    cursorKey: settings.cursorKey ?? null,
  };
  if (sorted.length === 0) return { airing: undefined, ...unchanged };
  if (settings.mode === 'every') return { airing: sorted[0], ...unchanged };

  if (settings.mode === 'daily') {
    const completedDay = settings.lastSuccessStart === null
      ? null
      : localDayAndMinute(settings.lastSuccessStart, settings.timeZone).day;
    const retryDay = retryStart === null ? null : localDayAndMinute(retryStart, settings.timeZone).day;
    return {
      airing: sorted.find(candidate => {
        const local = localDayAndMinute(candidate.startTime, settings.timeZone);
        if (retryDay !== null) return local.day === retryDay || local.minute >= settings.dailyStartMinutes;
        return local.day !== completedDay && local.minute >= settings.dailyStartMinutes;
      }),
      ...unchanged,
    };
  }
  if (retryStart !== null || settings.lastSuccessStart === null) return { airing: sorted[0], ...unchanged };
  if (settings.mode === 'hours') {
    const earliest = settings.lastSuccessStart + Math.max(1, settings.interval) * 60 * 60_000;
    return { airing: sorted.find(candidate => candidate.startTime >= earliest), ...unchanged };
  }

  const cursorStart = settings.cursorStart ?? settings.lastSuccessStart;
  const cursorKey = settings.cursorKey ?? null;
  const newCandidates = sorted.filter(candidate => isAfterCadenceCursor(candidate, cursorStart, cursorKey));
  const progress = Math.max(0, settings.occurrenceProgress ?? 0);
  const needed = Math.max(1, settings.interval) - progress;
  const airing = newCandidates[needed - 1];
  const consumed = airing ? newCandidates.slice(0, needed) : newCandidates;
  const cursor = consumed.at(-1);
  return {
    airing,
    occurrenceProgress: progress + consumed.length,
    cursorStart: cursor?.startTime ?? cursorStart,
    cursorKey: cursor?.airingKey ?? cursorKey,
  };
}

/** Select at most one outstanding reservation for a recurring rule. */
export function selectNextCadenceAiring<T extends CadenceAiring>(
  candidates: T[],
  history: CadenceHistoryEntry[],
  settings: CadenceSettings,
): T | undefined {
  return projectNextCadenceAiring(candidates, history, settings).airing;
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
