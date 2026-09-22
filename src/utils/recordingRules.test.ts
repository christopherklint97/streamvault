import { describe, expect, it } from 'vitest';
import { createRecordingRuleDraft, repeatPolicyDescription, ruleMatchesTitle } from './recordingRules';

describe('recording rule creation defaults', () => {
  it('defaults a SportsCenter rule to exact matching so title variants are excluded', () => {
    const draft = createRecordingRuleDraft({ id: 'espn', name: 'ESPN' }, 'SportsCenter');

    expect(draft.matchType).toBe('exact');
    expect(ruleMatchesTitle('SportsCenter', draft.matchTitle, draft.matchType)).toBe(true);
    expect(ruleMatchesTitle('SportsCenter with Scott Van Pelt', draft.matchTitle, draft.matchType)).toBe(false);
  });

  it('defaults to the repeat policy that records new and unknown episodes and explains every option', () => {
    const draft = createRecordingRuleDraft();
    expect(draft.repeatPolicy).toBe('include_unknown');
    expect(draft.retentionLimit).toBe('');
    expect(draft.recordOnce).toBe(false);
    expect(repeatPolicyDescription('all')).toContain('repeat');
    expect(repeatPolicyDescription('include_unknown')).toContain('unknown');
    expect(repeatPolicyDescription('new_only')).toContain('new');
  });
});
