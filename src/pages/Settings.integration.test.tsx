import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/appStore';
import { useChannelStore } from '../stores/channelStore';
import Settings from './Settings';

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
  const showToastMessage = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    useChannelStore.setState({
      commercialAutoSkip: false,
      apiBaseUrl: 'https://dvr.example.test',
      isLoading: false,
      error: null,
      saveConfig,
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
});
