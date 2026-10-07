// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { DBProgram } from './db.js';
import { refreshRuleChannelPrograms } from './rule-epg-refresh.js';

const program: DBProgram = {
  channel_id: 'live_42', title: 'SportsCenter', description: '', start_time: 100, stop_time: 200, category: 'Sports',
};

describe('recording-rule channel EPG refresh', () => {
  it('saves only non-empty successful refresh data', async () => {
    const save = vi.fn();
    const count = await refreshRuleChannelPrograms(
      ['live_42', 'manual-channel', 'live_99'],
      vi.fn(async ids => {
        expect(ids).toEqual([42, 99]);
        return [program];
      }),
      save,
    );
    expect(count).toBe(1);
    expect(save).toHaveBeenCalledWith([program]);
  });

  it('does not call the destructive channel snapshot writer after fetch failure or empty results', async () => {
    const save = vi.fn();
    expect(await refreshRuleChannelPrograms(['live_42'], async () => { throw new Error('upstream'); }, save)).toBe(0);
    expect(await refreshRuleChannelPrograms(['live_42'], async () => [], save)).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });
});
