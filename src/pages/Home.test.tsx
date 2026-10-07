import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from './Home';
import { useChannelStore } from '../stores/channelStore';
import { useFavoritesStore } from '../stores/favoritesStore';

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useChannelStore.setState({ _hydrated: false, backendConnection: 'unknown', contentTypeCounts: {}, programsByChannel: new Map(), isLoading: false, error: null, loadingMessage: '' });
  useFavoritesStore.setState({ favoriteIds: new Set(), lists: [] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Home startup state', () => {
  it('defers optional home requests until the backend bootstrap succeeds', async () => {
    useFavoritesStore.setState({ favoriteIds: new Set(['live_1']) });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"channels":[]}'));
    await act(async () => root.render(<Home />));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => useChannelStore.setState({ _hydrated: true, backendConnection: 'connected' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows library synchronization instead of onboarding while counts are still empty', async () => {
    useChannelStore.setState({ _hydrated: true, backendConnection: 'connected', isLoading: true, loadingMessage: 'Downloading channels…' });
    await act(async () => root.render(<Home />));
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Downloading channels');
    expect(container.textContent).not.toContain('add a playlist');
  });

  it('shows connection progress rather than add-playlist onboarding before bootstrap finishes', async () => {
    await act(async () => root.render(<Home />));
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Connecting to StreamVault');
    expect(container.textContent).not.toContain('add a playlist');
  });

  it('shows the startup error with working Retry and Settings actions', async () => {
    useChannelStore.setState({ _hydrated: true, backendConnection: 'disconnected', error: 'Server took too long. Retry.' });
    let resolveStatus!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(input => String(input).endsWith('/api/status')
      ? new Promise<Response>(resolve => { resolveStatus = resolve; })
      : Promise.resolve(new Response('{}')));
    await act(async () => root.render(<Home />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Server took too long');
    expect(container.textContent).not.toContain('add a playlist');
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry');
    expect(retry).toBeDefined();
    expect(container.textContent).toContain('Open Settings');
    await act(async () => retry?.click());
    expect(container.textContent).toContain('Connecting to StreamVault');
    await act(async () => {
      resolveStatus(new Response('{"isSyncing":false,"contentTypeCounts":{"livetv":23}}'));
    });
    expect(container.textContent).toContain('Live TV (23)');
  });
});
