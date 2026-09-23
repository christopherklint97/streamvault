// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  matchProgramTitle,
  projectNextCadenceAiring,
  reconcileScheduledAirings,
  selectNextCadenceAiring,
  shouldIncludeRepeat,
  shouldSuppressContentDuplicate,
  type ScheduledAiring,
} from './schedule-reconciliation.js';

describe('recording rule matching', () => {
  it('implements exact, contains, and startsWith distinctly', () => {
    expect(matchProgramTitle('SportsCenter', 'SportsCenter', 'exact')).toBe(true);
    expect(matchProgramTitle('SportsCenter with Scott Van Pelt', 'SportsCenter', 'exact')).toBe(false);
    expect(matchProgramTitle('SportsCenter with Scott Van Pelt', 'sportscenter', 'startsWith')).toBe(true);
    expect(matchProgramTitle('Late SportsCenter Replay', 'sportscenter', 'startsWith')).toBe(false);
    expect(matchProgramTitle('Late SportsCenter Replay', 'sportscenter', 'contains')).toBe(true);
  });

  it('applies all three repeat policies to explicit and unknown repeat metadata', () => {
    expect([0, 1, null].filter(value => shouldIncludeRepeat('all', value))).toEqual([0, 1, null]);
    expect([0, 1, null].filter(value => shouldIncludeRepeat('include_unknown', value))).toEqual([0, null]);
    expect([0, 1, null].filter(value => shouldIncludeRepeat('new_only', value))).toEqual([0]);
  });

  it('accepts trustworthy first-run metadata for new-only without including unknown SportsCenter airings', () => {
    expect(shouldIncludeRepeat('new_only', null, 1)).toBe(true);
    expect(shouldIncludeRepeat('new_only', null, null)).toBe(false);
    expect(shouldIncludeRepeat('new_only', 1, 1)).toBe(false);
    expect(shouldIncludeRepeat('include_unknown', null, null)).toBe(true);
  });

  it('deduplicates stable content except when the rule explicitly records all airings', () => {
    expect(shouldSuppressContentDuplicate('include_unknown', 'content-1', new Set(['content-1']))).toBe(true);
    expect(shouldSuppressContentDuplicate('new_only', 'content-1', new Set(['content-1']))).toBe(true);
    expect(shouldSuppressContentDuplicate('all', 'content-1', new Set(['content-1']))).toBe(false);
    expect(shouldSuppressContentDuplicate('include_unknown', null, new Set(['content-1']))).toBe(false);
  });
});

describe('airing-key schedule reconciliation', () => {
  const existing: ScheduledAiring[] = [
    { id: 'pending', airingKey: 'event-a', status: 'scheduled', startTime: 1000, endTime: 2000 },
    { id: 'active', airingKey: 'event-b', status: 'recording', startTime: 1000, endTime: 2000 },
  ];

  it('updates a moved pending airing in place but locks an active recording', () => {
    const result = reconcileScheduledAirings(existing, [
      { airingKey: 'event-a', startTime: 3000, endTime: 4000 },
      { airingKey: 'event-b', startTime: 3000, endTime: 4000 },
    ]);
    expect(result.updates).toEqual([{ id: 'pending', startTime: 3000, endTime: 4000 }]);
    expect(result.creates).toEqual([]);
  });

  it('keeps back-to-back same-title airings distinct by airing key', () => {
    const result = reconcileScheduledAirings([], [
      { airingKey: 'event-a', startTime: 1000, endTime: 2000 },
      { airingKey: 'event-b', startTime: 2000, endTime: 3000 },
    ]);
    expect(result.creates.map(item => item.airingKey)).toEqual(['event-a', 'event-b']);
  });
});

describe('recording cadence selection', () => {
  const hour = 60 * 60_000;
  const airing = (airingKey: string, startTime: number) => ({ airingKey, startTime });

  it('keeps one outstanding occurrence and selects every Nth match after success', () => {
    const candidates = [1, 2, 3, 4, 5, 6, 7].map(value => airing(`a${value}`, value * hour));

    expect(selectNextCadenceAiring(candidates, [], {
      mode: 'occurrence', interval: 3, dailyStartMinutes: 0, lastSuccessStart: null, timeZone: 'UTC',
    })?.airingKey).toBe('a1');
    expect(selectNextCadenceAiring(candidates.slice(1), [], {
      mode: 'occurrence', interval: 3, dailyStartMinutes: 0, lastSuccessStart: hour, timeZone: 'UTC',
    })?.airingKey).toBe('a4');
  });

  it('retries the next eligible occurrence after a failure without consuming cadence', () => {
    const candidates = [4, 5, 6, 7].map(value => airing(`a${value}`, value * hour));

    expect(selectNextCadenceAiring(candidates, [
      { airingKey: 'a3', startTime: 3 * hour, status: 'failed' },
    ], {
      mode: 'occurrence', interval: 3, dailyStartMinutes: 0, lastSuccessStart: hour, timeZone: 'UTC',
    })?.airingKey).toBe('a4');
  });

  it('persists occurrence progress across rolling guide windows', () => {
    const firstWindow = [2, 3, 4].map(value => airing(`a${value}`, value * hour));
    const first = projectNextCadenceAiring(firstWindow, [], {
      mode: 'occurrence', interval: 5, dailyStartMinutes: 0, lastSuccessStart: hour, timeZone: 'UTC',
      occurrenceProgress: 0, cursorStart: hour, cursorKey: 'a1', retryAfterStart: null, retryAfterKey: null,
    });
    expect(first.airing).toBeUndefined();
    expect(first.occurrenceProgress).toBe(3);
    expect(first.cursorKey).toBe('a4');

    const secondWindow = [5, 6, 7].map(value => airing(`a${value}`, value * hour));
    const second = projectNextCadenceAiring(secondWindow, [], {
      mode: 'occurrence', interval: 5, dailyStartMinutes: 0, lastSuccessStart: hour, timeZone: 'UTC',
      occurrenceProgress: first.occurrenceProgress,
      cursorStart: first.cursorStart,
      cursorKey: first.cursorKey,
      retryAfterStart: null,
      retryAfterKey: null,
    });
    expect(second.airing?.airingKey).toBe('a6');
    expect(second.occurrenceProgress).toBe(5);
    expect(second.cursorKey).toBe('a6');
  });

  it('retries from persisted rule state when failed recording history was deleted', () => {
    const candidates = [6, 7, 8].map(value => airing(`a${value}`, value * hour));
    expect(projectNextCadenceAiring(candidates, [], {
      mode: 'occurrence', interval: 5, dailyStartMinutes: 0, lastSuccessStart: hour, timeZone: 'UTC',
      occurrenceProgress: 5, cursorStart: 5 * hour, cursorKey: 'a5',
      retryAfterStart: 5 * hour, retryAfterKey: 'a5',
    }).airing?.airingKey).toBe('a6');
  });

  it('enforces a minimum elapsed interval and retries immediately after cancellation', () => {
    const candidates = [2, 5, 6, 8, 12].map(value => airing(`a${value}`, value * hour));
    expect(selectNextCadenceAiring(candidates, [], {
      mode: 'hours', interval: 6, dailyStartMinutes: 0, lastSuccessStart: 0, timeZone: 'UTC',
    })?.airingKey).toBe('a6');

    expect(selectNextCadenceAiring(candidates, [
      { airingKey: 'a5', startTime: 5 * hour, status: 'cancelled' },
    ], {
      mode: 'hours', interval: 6, dailyStartMinutes: 0, lastSuccessStart: 0, timeZone: 'UTC',
    })?.airingKey).toBe('a6');
  });

  it('selects the first matching programme at or after the local daily time', () => {
    const local = (day: number, hours: number, minutes: number) => Date.UTC(2026, 0, day, hours, minutes);
    const candidates = [
      airing('day1-early', local(1, 20, 55)),
      airing('day1-first', local(1, 21, 10)),
      airing('day1-later', local(1, 22, 0)),
      airing('day2-early', local(2, 20, 30)),
      airing('day2-first', local(2, 21, 5)),
    ];

    expect(selectNextCadenceAiring(candidates, [], {
      mode: 'daily', interval: 1, dailyStartMinutes: 21 * 60, lastSuccessStart: null, timeZone: 'UTC',
    })?.airingKey).toBe('day1-first');
    expect(selectNextCadenceAiring(candidates, [], {
      mode: 'daily', interval: 1, dailyStartMinutes: 21 * 60,
      lastSuccessStart: local(1, 21, 10), timeZone: 'UTC',
    })?.airingKey).toBe('day2-first');
  });

  it('does not let a failed daily attempt consume that local day', () => {
    const local = (hours: number, minutes: number) => Date.UTC(2026, 0, 1, hours, minutes);
    const candidates = [airing('retry', local(22, 0))];

    expect(selectNextCadenceAiring(candidates, [
      { airingKey: 'failed', startTime: local(21, 10), status: 'failed' },
    ], {
      mode: 'daily', interval: 1, dailyStartMinutes: 21 * 60, lastSuccessStart: null, timeZone: 'UTC',
    })?.airingKey).toBe('retry');
  });

  it('reapplies the daily threshold when a retry crosses into another local day', () => {
    const failed = Date.UTC(2026, 0, 1, 21, 0);
    const candidates = [
      airing('next-morning', Date.UTC(2026, 0, 2, 10, 0)),
      airing('next-evening', Date.UTC(2026, 0, 2, 21, 0)),
    ];
    expect(projectNextCadenceAiring(candidates, [], {
      mode: 'daily', interval: 1, dailyStartMinutes: 21 * 60, lastSuccessStart: null, timeZone: 'UTC',
      retryAfterStart: failed, retryAfterKey: 'failed',
    }).airing?.airingKey).toBe('next-evening');
  });

  it('uses the first real local time after a DST spring-forward gap', () => {
    const candidates = [
      airing('before-gap', Date.UTC(2026, 2, 29, 0, 45)),
      airing('after-gap', Date.UTC(2026, 2, 29, 1, 0)),
    ];
    expect(selectNextCadenceAiring(candidates, [], {
      mode: 'daily', interval: 1, dailyStartMinutes: 2 * 60 + 30,
      lastSuccessStart: null, timeZone: 'Europe/Stockholm',
    })?.airingKey).toBe('after-gap');
  });

  it('selects only the first matching airing through a DST fall-back fold', () => {
    const firstFold = Date.UTC(2026, 9, 25, 0, 30);
    const secondFold = Date.UTC(2026, 9, 25, 1, 30);
    const nextDay = Date.UTC(2026, 9, 26, 1, 30);
    const candidates = [
      airing('first-fold', firstFold),
      airing('second-fold', secondFold),
      airing('next-day', nextDay),
    ];
    expect(selectNextCadenceAiring(candidates, [], {
      mode: 'daily', interval: 1, dailyStartMinutes: 2 * 60 + 30,
      lastSuccessStart: Date.UTC(2026, 9, 24, 0, 30), timeZone: 'Europe/Stockholm',
    })?.airingKey).toBe('first-fold');
    expect(selectNextCadenceAiring(candidates.slice(1), [], {
      mode: 'daily', interval: 1, dailyStartMinutes: 2 * 60 + 30,
      lastSuccessStart: firstFold, timeZone: 'Europe/Stockholm',
    })?.airingKey).toBe('next-day');
  });
});
