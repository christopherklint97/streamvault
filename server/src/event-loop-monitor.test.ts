// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { startEventLoopMonitor } from './event-loop-monitor.js';

describe('event-loop stall monitor', () => {
  it('reports a late tick and resets the expected deadline', () => {
    let tick = () => {};
    let now = 0;
    const warn = vi.fn();
    const stop = startEventLoopMonitor(warn, () => now, callback => { tick = callback; return () => {}; });
    now = 1800; tick();
    expect(warn).toHaveBeenCalledWith('Event loop stalled for at least 800ms');
    now = 2800; tick();
    expect(warn).toHaveBeenCalledTimes(1);
    stop();
  });
});
