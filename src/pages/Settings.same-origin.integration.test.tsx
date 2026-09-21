import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChannelStore } from '../stores/channelStore';
import Settings from './Settings';

vi.mock('../stores/channelStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/channelStore')>();
  return { ...actual, SAME_ORIGIN: true };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('same-origin backend authentication', () => {
  let container: HTMLDivElement;
  let root: Root;
  const connectBackend = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    connectBackend.mockResolvedValue(true);
    useChannelStore.setState({
      apiBaseUrl: '',
      backendConnection: 'disconnected',
      error: null,
      isLoading: false,
      connectBackend,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Settings />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('allows a protected same-origin backend token to be entered before connecting', async () => {
    const tokenInput = container.querySelector<HTMLInputElement>('input[placeholder="Optional backend token"]');
    if (!tokenInput) throw new Error('Missing backend token field');
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(tokenInput, 'same-origin-token');
      tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const connectButton = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === 'Connect');
    if (!connectButton) throw new Error('Missing Connect button');

    await act(async () => connectButton.click());

    expect(connectBackend).toHaveBeenCalledWith('', 'same-origin-token');
  });
});
