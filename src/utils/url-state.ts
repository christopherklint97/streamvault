import type { View } from '../types';

/** Views that can be addressed via URL */
const URL_VIEWS = new Set<string>([
  'home', 'channels', 'movies', 'series', 'settings', 'guide', 'recordings',
]);

export function updateUrl(view: string, browseState?: { searchQuery?: string; selectedGroup?: string | null }) {
  const params = new URLSearchParams();
  if (view !== 'home') params.set('view', view);
  if (browseState?.searchQuery) params.set('q', browseState.searchQuery);
  if (browseState?.selectedGroup && browseState.selectedGroup !== 'All') {
    params.set('group', browseState.selectedGroup);
  }
  const search = params.toString();
  history.replaceState(history.state, '', search ? `?${search}` : window.location.pathname);
}

export function parseUrl(): { view: View; searchQuery: string; selectedGroup: string | null; playChannelId: string | null; playUrl: string | null } {
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get('view') || 'home';
  const view = (URL_VIEWS.has(rawView) ? rawView : 'home') as View;
  return {
    view,
    searchQuery: params.get('q') || '',
    selectedGroup: params.get('group') || null,
    playChannelId: params.get('play') || null,
    playUrl: params.get('url') || null,
  };
}
