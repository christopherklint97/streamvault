import { act } from '../test/act';
import { createElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createElement as compatCreateElement } from 'preact/compat';
import { createRoot as compatCreateRoot } from 'preact/compat/client';
import { isValidElement } from 'preact';
import { create } from 'zustand';
import { describe, expect, it, vi } from 'vitest';

describe('production frontend renderer in tests', () => {
  it('resolves React and client imports to the production Preact compatibility renderer', () => {
    expect(createElement).toBe(compatCreateElement);
    expect(createRoot).toBe(compatCreateRoot);
    expect(isValidElement(<span>Preact JSX</span>)).toBe(true);
  });

  it('renders and subscribes to Zustand through Preact rather than external React', async () => {
    const useCounter = create<{ count: number }>(() => ({ count: 0 }));
    function StoreCounter() {
      return <output>{useCounter((state) => state.count)}</output>;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<StoreCounter />));
      expect(container.textContent).toBe('0');
      await act(async () => useCounter.setState({ count: 1 }));
      expect(container.textContent).toBe('1');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('settles asynchronous work started by a mount effect before checking its rendered result', async () => {
    function ResponseCounter() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        void new Response('{"count":2}').json().then(({ count }: { count: number }) => setCount(count));
      }, []);
      return <output>{count}</output>;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ResponseCounter />));
      expect(container.textContent).toBe('2');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('preserves synchronous gesture callbacks and render flushing', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let inGesture = true;
    let handledInGesture = false;
    try {
      const settled = act(() => {
        handledInGesture = inGesture;
        root.render(<span>Committed</span>);
      });
      inGesture = false;
      expect(handledInGesture).toBe(true);
      expect(container.textContent).toBe('Committed');
      await settled;
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('does not advance fake playback deadlines while settling async work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const deadline = vi.fn();
    setTimeout(deadline, 1000);
    try {
      await act(async () => Promise.resolve());
      expect(Date.now()).toBe(0);
      expect(deadline).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(deadline).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates async callback failures instead of passing silently', async () => {
    await expect(act(async () => { throw new Error('failed interaction'); }))
      .rejects.toThrow('failed interaction');
  });

  it('flushes hook effects and interactive state with the same renderer as JSX', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let mounted = false;
    function Counter() {
      const [count, setCount] = useState(0);
      useEffect(() => { mounted = true; return () => { mounted = false; }; }, []);
      return <button onClick={() => setCount(count + 1)}>{count}</button>;
    }
    try {
      await act(async () => root.render(<Counter />));
      expect(mounted).toBe(true);
      const button = container.querySelector('button');
      expect(button?.textContent).toBe('0');
      await act(async () => button?.click());
      expect(button?.textContent).toBe('1');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
    expect(mounted).toBe(false);
  });
});
