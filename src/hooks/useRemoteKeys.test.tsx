import { act } from '../test/act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRemoteKeys } from './useRemoteKeys';
import { useAppStore } from '../stores/appStore';
import { KEY_CODES } from '../utils/keys';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ consumeBack }: { consumeBack: boolean }) {
  useRemoteKeys();
  return (
    <div
      data-testid="overlay"
      tabIndex={0}
      onKeyDown={(event) => { if (consumeBack && event.keyCode === KEY_CODES.BACK) event.preventDefault(); }}
    />
  );
}

function pressBack(target: Element) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'keyCode', { value: KEY_CODES.BACK });
  target.dispatchEvent(event);
}

describe('useRemoteKeys BACK', () => {
  let root: Root;
  let container: HTMLDivElement;
  const goBack = vi.fn(() => true);
  const originalGoBack = useAppStore.getState().goBack;

  beforeEach(() => {
    goBack.mockClear();
    useAppStore.setState({ goBack });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useAppStore.setState({ goBack: originalGoBack });
  });

  it('navigates back when no local overlay consumed the key', async () => {
    await act(async () => root.render(<Harness consumeBack={false} />));
    pressBack(container.querySelector('[data-testid="overlay"]')!);
    expect(goBack).toHaveBeenCalledOnce();
  });

  it('leaves the view alone when a React overlay (subtitle menu) already handled BACK', async () => {
    await act(async () => root.render(<Harness consumeBack />));
    pressBack(container.querySelector('[data-testid="overlay"]')!);
    expect(goBack).not.toHaveBeenCalled();
  });
});

function press(keyCode: number) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'keyCode', { value: keyCode });
  (document.activeElement ?? document.body).dispatchEvent(event);
}

function ContentHarness() {
  useRemoteKeys();
  return (
    <main data-app-content>
      <div style={{ display: 'none' }}><button data-focusable>Hidden kept-alive view</button></div>
      <button data-focusable>Visible entry</button>
    </main>
  );
}

describe('useRemoteKeys lost focus', () => {
  let root: Root;
  let container: HTMLDivElement;
  const originalView = useAppStore.getState().currentView;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useAppStore.setState({ currentView: originalView, showExitDialog: false });
  });

  it('moves focus to the visible content when an arrow arrives with nothing focused', async () => {
    useAppStore.setState({ currentView: 'home', showExitDialog: false });
    await act(async () => root.render(<ContentHarness />));
    // happy-dom has no layout: give the display:none subtree the empty box list a browser reports.
    const hidden = container.querySelector('[style] button')!;
    Object.defineProperty(hidden, 'getClientRects', { value: () => [] });
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    press(KEY_CODES.DOWN);

    expect(document.activeElement?.textContent).toBe('Visible entry');
  });

  it('leaves the player to handle its own keys', async () => {
    useAppStore.setState({ currentView: 'player', showExitDialog: false });
    await act(async () => root.render(<ContentHarness />));
    (document.activeElement as HTMLElement | null)?.blur();

    press(KEY_CODES.DOWN);

    expect(document.activeElement).toBe(document.body);
  });
});
