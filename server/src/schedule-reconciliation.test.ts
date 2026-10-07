// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { matchProgramTitle, reconcileScheduledAirings, shouldIncludeRepeat, shouldSuppressContentDuplicate, type ScheduledAiring } from './schedule-reconciliation.js';

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
