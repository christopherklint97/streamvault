import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './appStore';

describe('central navigation blocker', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
    useAppStore.setState({
      currentView: 'home',
      viewStack: [],
      selectedGroup: null,
      selectedSeries: null,
      selectedMovie: null,
      selectedRecordingId: null,
      navigationBlocker: null,
      showExitDialog: false,
    });
  });

  it('blocks in-app navigation and back navigation until the blocker allows leaving', () => {
    const blocker = vi.fn(() => false);
    useAppStore.getState().setNavigationBlocker(blocker);

    expect(useAppStore.getState().navigate('settings')).toBe(false);
    expect(useAppStore.getState().currentView).toBe('home');

    useAppStore.setState({ currentView: 'recordingDetail', viewStack: ['recordings'] });
    expect(useAppStore.getState().goBack()).toBe(false);
    expect(useAppStore.getState().currentView).toBe('recordingDetail');
    expect(blocker).toHaveBeenCalledTimes(2);
  });

  it('returns a blocked result for popstate callers and restores the current history entry', () => {
    useAppStore.setState({ currentView: 'recordingDetail', viewStack: ['recordings'] });
    useAppStore.getState().setNavigationBlocker(() => false);
    const pushState = vi.spyOn(history, 'pushState');

    expect(useAppStore.getState().handlePopNavigation()).toBe(false);
    expect(useAppStore.getState().currentView).toBe('recordingDetail');
    expect(pushState).toHaveBeenCalledWith({ view: 'recordingDetail', group: null }, '');
  });

  it('clears only the blocker that registered the cleanup', () => {
    const first = () => false;
    const second = () => true;
    const clearFirst = useAppStore.getState().setNavigationBlocker(first);
    useAppStore.getState().setNavigationBlocker(second);

    clearFirst();
    expect(useAppStore.getState().navigationBlocker).toBe(second);
    expect(useAppStore.getState().navigate('settings')).toBe(true);
  });
});
