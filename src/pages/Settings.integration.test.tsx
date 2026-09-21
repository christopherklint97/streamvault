import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/appStore';
import { useChannelStore } from '../stores/channelStore';
import Settings from './Settings';

vi.mock('../stores/channelStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/channelStore')>();
  return { ...actual, SAME_ORIGIN: false };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function autoSkipButton(container: HTMLElement): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>('button[role="switch"]');
  if (!result) throw new Error('Missing commercial auto-skip control');
  return result;
}

describe('Settings commercial auto-skip integration', () => {
  let container: HTMLDivElement;
  let root: Root;
  const saveConfig = vi.fn();
  const connectBackend = vi.fn();
  const triggerSync = vi.fn();
  const showToastMessage = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    useChannelStore.setState({
      commercialAutoSkip: false,
      apiBaseUrl: 'https://dvr.example.test',
      backendConnection: 'connected',
      inputMode: 'xtream',
      xtreamCredentials: {
        serverUrl: 'https://provider.example.test',
        username: 'subscriber',
        password: 'secret',
      },
      isLoading: false,
      error: null,
      connectBackend,
      saveConfig,
      triggerSync,
    });
    useAppStore.setState({ showToastMessage });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Settings />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('shows a disabled pending state and does not announce success when saveConfig returns false', async () => {
    let finish!: (saved: boolean) => void;
    saveConfig.mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));

    await act(async () => autoSkipButton(container).click());

    expect(autoSkipButton(container).disabled).toBe(true);
    expect(autoSkipButton(container).textContent).toContain('Saving');

    await act(async () => {
      finish(false);
      await Promise.resolve();
    });

    expect(autoSkipButton(container).disabled).toBe(false);
    expect(showToastMessage).not.toHaveBeenCalledWith('Automatic commercial skipping on');
  });

  it('announces the new state only after saveConfig succeeds', async () => {
    saveConfig.mockResolvedValue(true);

    await act(async () => {
      autoSkipButton(container).click();
      await Promise.resolve();
    });

    expect(saveConfig).toHaveBeenCalledWith({ commercialAutoSkip: true });
    expect(showToastMessage).toHaveBeenCalledWith('Automatic commercial skipping on');
  });

  it('hides provider controls whenever the backend has not been verified', async () => {
    await act(async () => useChannelStore.setState({ backendConnection: 'disconnected' }));

    expect(container.textContent).not.toContain('Xtream Codes Login');
    expect(container.textContent).not.toContain('Connect & Sync');
  });

  it('passes an optional backend token when connecting to a protected server', async () => {
    connectBackend.mockResolvedValue(true);
    await act(async () => useChannelStore.setState({ backendConnection: 'disconnected' }));
    const serverInput = container.querySelector<HTMLInputElement>('input[placeholder="http://backend-ip:3002"]');
    const tokenInput = container.querySelector<HTMLInputElement>('input[placeholder="Optional backend token"]');
    if (!serverInput || !tokenInput) throw new Error('Missing backend connection fields');

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(serverInput, 'https://protected.example.test');
      serverInput.dispatchEvent(new Event('input', { bubbles: true }));
      valueSetter?.call(tokenInput, 'new-backend-token');
      tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const connectButton = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === 'Connect');
    if (!connectButton) throw new Error('Missing Connect button');

    await act(async () => connectButton.click());

    expect(connectBackend).toHaveBeenCalledWith('https://protected.example.test', 'new-backend-token');
  });

  it('does not start a sync when saving Xtream credentials fails', async () => {
    saveConfig.mockResolvedValue(false);
    const button = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('Connect & Sync'));
    if (!button) throw new Error('Missing Connect & Sync button');

    await act(async () => button.click());

    expect(saveConfig).toHaveBeenCalledWith({
      inputMode: 'xtream',
      xtreamServer: 'https://provider.example.test',
      xtreamUsername: 'subscriber',
      xtreamPassword: 'secret',
    });
    expect(triggerSync).not.toHaveBeenCalled();
  });

  it('reinitializes provider drafts after connecting a different backend', async () => {
    await act(async () => useChannelStore.setState({
      apiBaseUrl: 'https://second-backend.example.test',
      backendConnection: 'connected',
      xtreamCredentials: {
        serverUrl: 'https://second-provider.example.test',
        username: 'second-user',
        password: 'second-password',
      },
    }));

    expect(container.querySelector<HTMLInputElement>('input[placeholder="http://example.com"]')?.value)
      .toBe('https://second-provider.example.test');
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Your username"]')?.value)
      .toBe('second-user');
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Your password"]')?.value)
      .toBe('second-password');
  });
});
