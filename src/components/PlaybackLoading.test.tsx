import { act } from '../test/act';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import PlaybackLoading from './PlaybackLoading';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.useRealTimers(); });

it('shows elapsed startup time and offers retry after a slow live start', async () => {
  vi.useFakeTimers();
  const retry = vi.fn();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => { await act(async () => root.unmount()); container.remove(); };
  await act(async () => root.render(<PlaybackLoading live onRetry={retry} />));
  expect(container.textContent).toContain('Starting live stream');
  expect(container.querySelector('button')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(8000));
  expect(container.textContent).toContain('8s');
  expect(container.textContent).toContain('Taking longer than usual');
  await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
  expect(retry).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
});
