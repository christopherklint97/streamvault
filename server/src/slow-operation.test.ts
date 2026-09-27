// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { measureSlowOperation } from './slow-operation.js';

describe('slow operation diagnostics', () => {
  it('reports a slow synchronous operation with its name and duration', () => {
    const warn = vi.fn();
    const result = measureSlowOperation('EPG read', () => {
      const start = performance.now();
      while (performance.now() - start < 3) { /* simulate blocking I/O */ }
      return 42;
    }, warn, 1);
    expect(result).toBe(42);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Slow EPG read: \d+ms$/));
  });

  it('does not log a fast operation or alter a thrown error', () => {
    const warn = vi.fn();
    expect(measureSlowOperation('EPG read', () => 'ok', warn, 500)).toBe('ok');
    const error = new Error('failed');
    expect(() => measureSlowOperation('EPG write', () => { throw error; }, warn, 500)).toThrow(error);
    expect(warn).not.toHaveBeenCalled();
  });
});
