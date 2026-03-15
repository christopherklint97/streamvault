import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { Channel, View } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { useFavoritesStore } from '../stores/favoritesStore';
import { isMobile } from '../utils/platform';
import { cn } from '../utils/cn';

const MOBILE = isMobile();
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import {
  getRecentChannelIds,
  getLastWatchedChannelId,
  getContinueWatchingIds,
  getWatchProgress,
} from '../services/channel-service';
import { getCurrentProgram } from '../services/epg-service';
import { KEY_CODES } from '../utils/keys';
import HorizontalRow from '../components/HorizontalRow';

export default function Home() {
  const programs = useChannelStore((s) => s.programs);
  const contentTypeCounts = useChannelStore((s) => s.contentTypeCounts);
  const fetchChannelsByIds = useChannelStore((s) => s.fetchChannelsByIds);
  const favoriteIds = useFavoritesStore((s) => s.favoriteIds);
  const lists = useFavoritesStore((s) => s.lists);
  const createList = useFavoritesStore((s) => s.createList);
  const deleteList = useFavoritesStore((s) => s.deleteList);
  const renameList = useFavoritesStore((s) => s.renameList);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);

  const [newListName, setNewListName] = useState('');
  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [editingListName, setEditingListName] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch all channels needed for home sections from the server
  const [channelMap, setChannelMap] = useState<Map<string, Channel>>(new Map());

  const recentIds = useMemo(() => getRecentChannelIds(), []);
  const lastWatchedId = useMemo(() => getLastWatchedChannelId(), []);
  const continueWatchingIds = useMemo(() => getContinueWatchingIds(), []);
  const listChannelIds = useMemo(
    () => lists.flatMap(l => l.channelIds),
    [lists]
  );

  // Collect all IDs we need and batch-fetch from server
  useEffect(() => {
    const allIds = new Set<string>();
    for (const id of favoriteIds) allIds.add(id);
    for (const id of recentIds) allIds.add(id);
    for (const id of continueWatchingIds) allIds.add(id);
    for (const id of listChannelIds) allIds.add(id);
    if (lastWatchedId) allIds.add(lastWatchedId);

    if (allIds.size === 0) return;

    let cancelled = false;
    fetchChannelsByIds(Array.from(allIds)).then(channels => {
      if (cancelled) return;
      const map = new Map<string, Channel>();
      for (const ch of channels) map.set(ch.id, ch);
      setChannelMap(map);
    });
    return () => { cancelled = true; };
  }, [favoriteIds, recentIds, lastWatchedId, continueWatchingIds, listChannelIds, fetchChannelsByIds]);

  const favoriteChannels = useMemo(
    () => Array.from(favoriteIds).map(id => channelMap.get(id)).filter(Boolean) as Channel[],
    [channelMap, favoriteIds]
  );

  const recentChannels = useMemo(
    () => recentIds.map(id => channelMap.get(id)).filter(Boolean) as Channel[],
    [channelMap, recentIds]
  );

  const lastWatchedChannel = useMemo(
    () => (lastWatchedId ? channelMap.get(lastWatchedId) ?? null : null),
    [channelMap, lastWatchedId]
  );

  const continueWatchingChannels = useMemo(
    () => continueWatchingIds.map(id => channelMap.get(id)).filter(Boolean) as Channel[],
    [channelMap, continueWatchingIds]
  );

  const navigateToSeries = useAppStore((s) => s.navigateToSeries);
  const navigateToMovie = useAppStore((s) => s.navigateToMovie);

  const handleSelectChannel = useCallback(
    (channel: Channel) => {
      // Series containers have no URL — open series detail instead
      if (channel.contentType === 'series' && !channel.url) {
        navigateToSeries(channel);
        return;
      }
      // Movies go to detail page
      if (channel.contentType === 'movies') {
        navigateToMovie(channel);
        return;
      }
      setChannel(channel);
      navigate('player');
    },
    [setChannel, navigate, navigateToSeries, navigateToMovie]
  );

  const lastWatchedProgram = lastWatchedChannel
    ? getCurrentProgram(programs, lastWatchedChannel.id)
    : null;

  const typeCounts = useMemo(() => ({
    livetv: contentTypeCounts['livetv'] || 0,
    movies: contentTypeCounts['movies'] || 0,
    series: contentTypeCounts['series'] || 0,
  }), [contentTypeCounts]);

  // Simple key handler: ENTER clicks, UP/DOWN/LEFT/RIGHT navigate focusables
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const active = document.activeElement as HTMLElement;
    if (!active) return;

    // Text inputs: pass through LEFT/RIGHT
    if (active.tagName === 'INPUT' && (e.keyCode === KEY_CODES.LEFT || e.keyCode === KEY_CODES.RIGHT)) return;

    if (e.keyCode === KEY_CODES.ENTER) {
      if (active.tagName !== 'INPUT') {
        e.preventDefault();
        active.click();
      }
      return;
    }

    // Simple sequential navigation through all focusables
    const container = containerRef.current;
    if (!container) return;
    const items = container.querySelectorAll('[data-focusable]') as NodeListOf<HTMLElement>;
    if (items.length === 0) return;

    let idx = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i] === active) { idx = i; break; }
    }

    let next = idx;
    if (e.keyCode === KEY_CODES.DOWN) {
      next = Math.min(idx + 1, items.length - 1);
    } else if (e.keyCode === KEY_CODES.UP) {
      next = Math.max(idx - 1, 0);
    } else if (e.keyCode === KEY_CODES.RIGHT) {
      next = Math.min(idx + 1, items.length - 1);
    } else if (e.keyCode === KEY_CODES.LEFT) {
      if (idx <= 0) return; // bubble to sidebar
      next = idx - 1;
    } else {
      return;
    }

    if (next !== idx && next >= 0) {
      e.preventDefault();
      e.stopPropagation();
      items[next].focus({ preventScroll: true });
      items[next].scrollIntoView({ block: 'nearest' });
    }
  }, []);

  // Auto-focus first item on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const first = container.querySelector('[data-focusable]') as HTMLElement | null;
      first?.focus({ preventScroll: true });
    });
  }, []);

  const hasContent = typeCounts.livetv > 0 || typeCounts.movies > 0 || typeCounts.series > 0 || channelMap.size > 0;
  if (!hasContent) {
    return (
      <div className={cn('flex flex-col gap-5 lg:gap-7 outline-hidden animate-fade-in', 'justify-center items-center min-h-[60dvh] lg:h-full')} ref={containerRef} onKeyDown={handleKeyDown}>
        <div className="text-center">
          <h1 className="text-22 lg:text-32 mb-3">Welcome to StreamVault</h1>
          <p className="text-sm lg:text-18 text-[#888] mb-6">Go to Settings to add a playlist URL and start watching.</p>
          <button
            className="py-3 px-7 lg:py-3.5 lg:px-9 bg-transparent text-accent text-base lg:text-18 font-bold border-2 border-accent rounded-lg transition-all duration-150 focus:border-white focus:scale-[1.04]"
            data-focusable
            tabIndex={0}
            onClick={() => navigate('settings')}
          >
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 lg:gap-7 outline-hidden animate-fade-in" ref={containerRef} onKeyDown={handleKeyDown}>
      {/* Continue Watching */}
      {continueWatchingChannels.length > 0 && (
        <div className="flex flex-col [contain:layout_style]">
          <h2 className="text-base lg:text-22 font-bold mb-2 lg:mb-3 text-[#ccc]">Continue Watching</h2>
          <div className="flex gap-2.5 lg:gap-4 overflow-x-auto py-2 px-1 [contain:content] [will-change:scroll-position] [-webkit-overflow-scrolling:touch]">
            {continueWatchingChannels.map((ch) => {
              const progress = getWatchProgress(ch.id);
              const pct = progress && progress.duration > 0
                ? Math.round((progress.position / progress.duration) * 100)
                : 0;
              return (
                <div
                  key={ch.id}
                  className="w-[140px] lg:w-[220px] shrink-0 bg-surface border-2 border-transparent rounded-lg overflow-hidden cursor-pointer transition-all duration-180 tap-none active:scale-[0.97] lg:active:scale-100 focus:border-accent focus:scale-[1.06] focus:z-[2]"
                  data-focusable
                  tabIndex={-1}
                  onClick={() => handleSelectChannel(ch)}
                >
                  <div className="w-full h-14 lg:h-20 flex items-center justify-center bg-dark-deep overflow-hidden">
                    {ch.logo ? (
                      <img className="max-w-12 lg:max-w-16 max-h-9 lg:max-h-12 object-contain" src={ch.logo} alt={ch.name} width={64} height={48} loading="lazy" decoding="async" />
                    ) : (
                      <div className="w-12 h-12 rounded-full flex items-center justify-center bg-[#222] text-22 font-bold">
                        {ch.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="p-2 lg:p-2.5">
                    <span className="text-12 lg:text-base font-semibold block whitespace-nowrap overflow-hidden text-ellipsis">{ch.name}</span>
                    <span className="text-11 lg:text-13 text-[#555]">{ch.group}</span>
                  </div>
                  <div className="h-[3px] bg-surface-border">
                    <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Last Watched */}
      {lastWatchedChannel && (
        <div className="flex flex-col [contain:layout_style]">
          <h2 className="text-base lg:text-22 font-bold mb-2 lg:mb-3 text-[#ccc]">Pick Up Where You Left Off</h2>
          <div
            className="flex gap-3 lg:gap-5 p-3 lg:p-5 bg-surface border-2 border-transparent rounded-[10px] cursor-pointer transition-all duration-180 tap-none active:scale-[0.98] lg:active:scale-100 focus:border-accent focus:scale-[1.02]"
            data-focusable
            tabIndex={-1}
            onClick={() => handleSelectChannel(lastWatchedChannel)}
          >
            <div className="w-12 h-12 lg:w-[72px] lg:h-[72px] shrink-0 flex items-center justify-center bg-dark-deep rounded-md lg:rounded-lg overflow-hidden">
              {lastWatchedChannel.logo ? (
                <img className="max-w-10 lg:max-w-14 max-h-9 lg:max-h-12 object-contain" src={lastWatchedChannel.logo} alt={lastWatchedChannel.name} width={56} height={48} loading="lazy" decoding="async" />
              ) : (
                <div className="text-36 font-bold text-[#555]">
                  {lastWatchedChannel.name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div>
              <h3 className="text-base lg:text-22 font-bold">{lastWatchedChannel.name}</h3>
              {lastWatchedProgram && <p className="text-13 lg:text-17 text-[#aaa] mt-1">{lastWatchedProgram.title}</p>}
              <span className="text-12 lg:text-15 text-[#555] mt-1 block">{lastWatchedChannel.group}</span>
            </div>
          </div>
        </div>
      )}

      {/* Favorites */}
      {favoriteChannels.length > 0 && (
        <div className="flex flex-col [contain:layout_style]">
          <HorizontalRow
            title="Favorites"
            channels={favoriteChannels}
            onSelect={handleSelectChannel}
          />
        </div>
      )}

      {/* Custom Lists */}
      {lists.map(list => {
        const listChannels = list.channelIds.map(id => channelMap.get(id)).filter(Boolean) as Channel[];
        if (listChannels.length === 0) return null;
        return (
          <div key={list.id} className="flex flex-col [contain:layout_style]">
            <div className="flex items-center gap-2 mb-2">
              {editingListId === list.id ? (
                <form className="flex-1" onSubmit={(e) => {
                  e.preventDefault();
                  if (editingListName.trim()) {
                    renameList(list.id, editingListName.trim());
                  }
                  setEditingListId(null);
                }}>
                  <input
                    className="w-full py-1.5 px-2.5 bg-surface border border-accent rounded-md text-white text-base font-bold"
                    value={editingListName}
                    onChange={(e) => setEditingListName(e.target.value)}
                    autoFocus
                    onBlur={() => setEditingListId(null)}
                  />
                </form>
              ) : (
                <h2
                  className="text-base lg:text-22 font-bold mb-2 lg:mb-3 text-[#ccc]"
                  onClick={MOBILE ? () => { setEditingListId(list.id); setEditingListName(list.name); } : undefined}
                >
                  {list.name}
                </h2>
              )}
              {MOBILE && (
                <button
                  className="w-7 h-7 rounded-full bg-white/[0.08] border-none text-12 text-[#888] flex items-center justify-center tap-none"
                  onClick={() => deleteList(list.id)}
                >
                  {'\u2715'}
                </button>
              )}
            </div>
            <HorizontalRow
              title=""
              channels={listChannels}
              onSelect={handleSelectChannel}
            />
          </div>
        );
      })}

      {/* Create New List */}
      {MOBILE && (
        <div className="flex flex-col [contain:layout_style]">
          <form className="flex gap-2 items-center" onSubmit={(e) => {
            e.preventDefault();
            if (newListName.trim()) {
              createList(newListName.trim());
              setNewListName('');
            }
          }}>
            <input
              className="flex-1 py-2.5 px-3.5 bg-surface border border-white/10 rounded-lg text-[#e8eaed] text-sm placeholder:text-[#444] focus:border-accent"
              type="text"
              placeholder="Create new list..."
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
            />
            {newListName.trim() && (
              <button className="py-2.5 px-4 bg-accent text-black border-none rounded-lg text-sm font-semibold tap-none" type="submit">Create</button>
            )}
          </form>
        </div>
      )}

      {/* Recently Watched */}
      {recentChannels.length > 0 && (
        <div className="flex flex-col [contain:layout_style]">
          <HorizontalRow
            title="Recently Watched"
            channels={recentChannels}
            onSelect={handleSelectChannel}
          />
        </div>
      )}

      {/* Browse by Type */}
      <div className="flex flex-col [contain:layout_style]">
        <h2 className="text-base lg:text-22 font-bold mb-2 lg:mb-3 text-[#ccc]">Browse</h2>
        <div className="flex gap-2 lg:gap-4 flex-wrap">
          {([
            { label: 'Live TV', view: 'channels' as View, count: typeCounts.livetv },
            { label: 'Movies', view: 'movies' as View, count: typeCounts.movies },
            { label: 'Series', view: 'series' as View, count: typeCounts.series },
          ]).map((item) => (
            <button
              key={item.view}
              className="py-3.5 px-4 lg:py-5 lg:px-8 bg-surface border-2 border-transparent rounded-[10px] text-sm lg:text-18 font-semibold text-[#999] cursor-pointer transition-all duration-180 flex-1 text-center min-w-[90px] lg:min-w-0 lg:flex-none tap-none active:scale-[0.97] lg:active:scale-100 focus:border-accent focus:text-white focus:bg-surface-hover focus:scale-[1.04]"
              data-focusable
              tabIndex={-1}
              onClick={() => navigate(item.view)}
            >
              {item.label} ({item.count})
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
