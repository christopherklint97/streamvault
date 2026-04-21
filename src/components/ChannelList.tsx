import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Channel, ContentType, Category } from '../types';
import { usePlayerStore } from '../stores/playerStore';
import { useChannelStore, SAME_ORIGIN } from '../stores/channelStore';
import { useAppStore } from '../stores/appStore';
import { KEY_CODES } from '../utils/keys';
import { prefetchImages } from '../utils/image-pool';
import { markKeyDown, markKeyRendered } from '../utils/perf-monitor';
import { isMobile } from '../utils/platform';
import { cn } from '../utils/cn';
import ChannelCard from './ChannelCard';
import { useFavoritesStore } from '../stores/favoritesStore';
import { fetchBatchEpg, getCurrentEpg, type EpgProgram, type EpgMap } from '../utils/epg-batch';

interface ChannelListProps {
  contentType: ContentType;
}

const MOBILE = isMobile();
const COLUMN_COUNT = MOBILE ? 3 : 6;
const ROW_HEIGHT = MOBILE ? 200 : 260;
const CONTAINER_HEIGHT = 900;
const BUFFER = 2;
const PREFETCH_ROWS = 3;
const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE = MOBILE ? 18 : 20;

// ---------- API helper ----------

function getApiBase(): string {
  return SAME_ORIGIN ? '' : useChannelStore.getState().apiBaseUrl;
}

async function apiBrowse(contentType: string, group?: string, limit = PAGE_SIZE, afterCursor?: string): Promise<{ channels: Channel[]; total: number; nextCursor: string | null }> {
  const base = getApiBase();
  const params = new URLSearchParams();
  params.set('type', contentType);
  if (group && group !== 'All') params.set('group', group);
  params.set('limit', String(limit));
  if (afterCursor) params.set('after', afterCursor);
  const resp = await fetch(`${base}/api/browse?${params}`);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

// ---------- EPG Progress Bar ----------

function EpgProgressBar({ programs }: { programs: EpgProgram[] | undefined }) {
  const { current, progress } = useMemo(() => getCurrentEpg(programs), [programs]);
  if (!current) return null;

  const start = new Date(current.start);
  const stop = new Date(current.stop);
  const fmt = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="flex flex-col gap-[3px] w-full">
      <div className="h-[3px] bg-white/[0.08] rounded-sm overflow-hidden">
        <div className="h-full bg-epg-purple rounded-sm transition-[width] duration-300" style={{ width: `${Math.min(progress * 100, 100)}%` }} />
      </div>
      <div className="flex justify-between items-center gap-2">
        <span className="text-12 text-[#888] flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{current.title}</span>
        <span className="text-11 text-[#555] shrink-0">{fmt(start)} – {fmt(stop)}</span>
      </div>
    </div>
  );
}

// ---------- Filter Dropdown ----------

interface FilterDropdownProps {
  categories: Category[];
  selectedGroup: string | null;
  onSelect: (group: string) => void;
}

function FilterDropdown({ categories, selectedGroup, onSelect }: FilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!filterQuery.trim()) return categories;
    const q = filterQuery.toLowerCase();
    return categories.filter(c => c.name.toLowerCase().includes(q));
  }, [categories, filterQuery]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus input when opened — reset filter state in the event handler, not the effect
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const handleToggle = useCallback(() => {
    setOpen(prev => {
      if (!prev) {
        // Opening: reset state
        setFilterQuery('');
        setFocusIdx(-1);
      }
      return !prev;
    });
  }, []);

  // Scroll focused item into view
  useEffect(() => {
    if (!open || focusIdx < 0) return;
    const list = listRef.current;
    if (!list) return;
    const items = list.querySelectorAll('[data-filter-item]') as NodeListOf<HTMLElement>;
    if (focusIdx < items.length) {
      const item = items[focusIdx];
      const top = item.offsetTop;
      const bottom = top + item.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top - 4;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
    }
  }, [focusIdx, open]);

  const handleSelect = useCallback((name: string) => {
    onSelect(name);
    setOpen(false);
  }, [onSelect]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.keyCode === KEY_CODES.ENTER) {
        e.preventDefault();
        handleToggle();
      }
      return;
    }

    if (e.keyCode === KEY_CODES.DOWN) {
      e.preventDefault();
      e.stopPropagation();
      setFocusIdx(prev => Math.min(prev + 1, filtered.length)); // +1 for "All"
    } else if (e.keyCode === KEY_CODES.UP) {
      e.preventDefault();
      e.stopPropagation();
      if (focusIdx <= 0) {
        setFocusIdx(-1);
        inputRef.current?.focus();
      } else {
        setFocusIdx(prev => prev - 1);
      }
    } else if (e.keyCode === KEY_CODES.ENTER) {
      e.preventDefault();
      e.stopPropagation();
      if (focusIdx === 0) {
        handleSelect('All');
      } else if (focusIdx > 0 && focusIdx <= filtered.length) {
        handleSelect(filtered[focusIdx - 1].name);
      }
    } else if (e.keyCode === KEY_CODES.BACK || e.keyCode === 27) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }, [open, focusIdx, filtered, handleSelect, handleToggle]);

  const label = selectedGroup && selectedGroup !== 'All' ? selectedGroup : 'All categories';

  return (
    <div className="relative shrink-0" ref={containerRef} onKeyDown={handleKeyDown}>
      <button
        className={cn(
          'flex items-center gap-2 py-2.5 px-3.5 lg:py-3 lg:px-[18px] bg-surface border-2 border-surface-border rounded-lg text-sm lg:text-17 font-semibold text-[#ccc] whitespace-nowrap transition-all duration-150 w-full lg:w-auto lg:max-w-[320px] tap-none',
          open && 'border-accent text-white'
        )}
        data-filter-trigger
        onClick={handleToggle}
        tabIndex={0}
      >
        <span className="overflow-hidden text-ellipsis">{label}</span>
        <span className="text-12 text-[#555] shrink-0">{open ? '\u25B2' : '\u25BC'}</span>
      </button>

      {open && (
        <div className="absolute top-[calc(100%+6px)] left-0 right-0 lg:min-w-[320px] lg:max-w-[460px] bg-surface border-2 border-surface-border rounded-[10px] z-[100] flex flex-col animate-fade-in-fast shadow-[0_12px_40px_rgba(0,0,0,0.6)] max-h-[60dvh] lg:max-h-none">
          <input
            ref={inputRef}
            className="py-2.5 px-3 lg:py-3 lg:px-3.5 text-sm lg:text-17 bg-dark-deep border-none border-b border-surface-border rounded-t-[10px] text-[#e8eaed] outline-hidden placeholder:text-[#444]"
            type="text"
            placeholder="Search categories..."
            value={filterQuery}
            onChange={e => { setFilterQuery(e.target.value); setFocusIdx(-1); }}
          />
          <div className="max-h-[50dvh] lg:max-h-[400px] overflow-y-auto p-1 [-webkit-overflow-scrolling:touch]" ref={listRef}>
            <button
              className={cn(
                'flex items-center gap-2 w-full py-3 px-3.5 lg:py-[11px] lg:px-3.5 bg-transparent border-none rounded-md text-left text-sm lg:text-base text-[#aaa] cursor-pointer transition-colors duration-100 tap-none hover:bg-surface-hover hover:text-white',
                (selectedGroup === 'All' || !selectedGroup) && 'text-accent',
                focusIdx === 0 && 'bg-surface-hover text-white outline-2 outline-accent outline-offset-[-2px]'
              )}
              data-filter-item
              onClick={() => handleSelect('All')}
            >
              All categories
            </button>
            {filtered.map((cat, i) => (
              <button
                key={cat.id}
                className={cn(
                  'flex items-center gap-2 w-full py-3 px-3.5 lg:py-[11px] lg:px-3.5 bg-transparent border-none rounded-md text-left text-sm lg:text-base text-[#aaa] cursor-pointer transition-colors duration-100 tap-none hover:bg-surface-hover hover:text-white',
                  selectedGroup === cat.name && 'text-accent',
                  focusIdx === i + 1 && 'bg-surface-hover text-white outline-2 outline-accent outline-offset-[-2px]'
                )}
                data-filter-item
                onClick={() => handleSelect(cat.name)}
              >
                <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{cat.name}</span>
                {cat.stream_count > 0 && (
                  <span className="text-13 text-[#555] shrink-0">{cat.stream_count}</span>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="p-5 text-center text-15 text-[#444]">No matching categories</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Live TV List Item (mobile) ----------

function LiveListItem({ channel, onSelect, vindex, epgPrograms }: { channel: Channel; onSelect: (ch: Channel) => void; vindex: number; epgPrograms?: EpgProgram[] }) {
  const isFav = useFavoritesStore((s) => s.favoriteIds.has(channel.id));
  const toggle = useFavoritesStore((s) => s.toggleFavorite);
  return (
    <div className="flex items-center gap-0 bg-surface" data-vindex={vindex}>
      <button className="flex flex-col items-stretch gap-1.5 py-3.5 px-3 lg:px-4 flex-1 min-w-0 bg-transparent border-none text-left tap-none active:bg-white/[0.04]" onClick={() => onSelect(channel)}>
        <span className="text-15 font-medium text-[#e8eaed] flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{channel.name}</span>
        <EpgProgressBar programs={epgPrograms} />
      </button>
      <button
        className={cn(
          'w-11 h-11 flex items-center justify-center bg-transparent border-none text-18 text-[#444] shrink-0 tap-none',
          isFav && 'text-favorite'
        )}
        onClick={() => toggle(channel.id)}
      >
        {isFav ? '\u2605' : '\u2606'}
      </button>
    </div>
  );
}

// ---------- Channel List ----------

type FocusZone = 'search' | 'filter' | 'grid';

export default function ChannelList({ contentType }: ChannelListProps) {
  const viewName = contentType === 'livetv' ? 'channels' : contentType;
  const savedBrowse = useAppStore((s) => s.browseStates[viewName]);
  const setBrowseState = useAppStore((s) => s.setBrowseState);

  const [searchQuery, setSearchQuery] = useState(savedBrowse?.searchQuery ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState(savedBrowse?.searchQuery ?? '');
  const [selectedGroup, setSelectedGroup] = useState<string | null>(savedBrowse?.selectedGroup ?? 'All');
  const [isSearching, setIsSearching] = useState(false);
  const [focusZone, setFocusZone] = useState<FocusZone>('search');
  const [focusIndex, setFocusIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Local channel list state (not global store)
  const [channels, setChannels] = useState<Channel[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // EPG data for live TV channels
  const [epgMap, setEpgMap] = useState<EpgMap>({});
  const fetchedEpgIdsRef = useRef<Set<string>>(new Set());

  const categories = useChannelStore((s) => s.categories);
  const fetchCategories = useChannelStore((s) => s.fetchCategories);
  const searchChannelsFn = useChannelStore((s) => s.searchChannels);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
  const navigateToSeries = useAppStore((s) => s.navigateToSeries);
  const navigateToMovie = useAppStore((s) => s.navigateToMovie);
  const showToast = useAppStore((s) => s.showToastMessage);

  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchIdRef = useRef(0); // to discard stale responses

  // Fetch categories on mount
  useEffect(() => {
    fetchCategories(contentType);
  }, [contentType, fetchCategories]);

  // Load the first page of channels for the current category
  useEffect(() => {
    const id = ++fetchIdRef.current;
    let cancelled = false;
    const group = selectedGroup && selectedGroup !== 'All' ? selectedGroup : undefined;

    apiBrowse(contentType, group, PAGE_SIZE).then(data => {
      if (cancelled || fetchIdRef.current !== id) return;
      // If "All" returned 0 results but we have categories, auto-select the first one
      if (data.total === 0 && !group && categories.length > 0) {
        setSelectedGroup(categories[0].name);
        return;
      }
      setChannels(data.channels);
      setTotalCount(data.total);
      setNextCursor(data.nextCursor);
      setInitialLoading(false);
      setFocusIndex(0);
      setScrollOffset(0);
    }).catch((err) => {
      if (cancelled || fetchIdRef.current !== id) return;
      showToast(`Failed to load channels: ${err}`);
      setInitialLoading(false);
    });

    return () => { cancelled = true; };
  }, [contentType, selectedGroup, categories, showToast]);

  // Load the next page (triggered by scroll proximity)
  const loadNextPage = useCallback(async () => {
    if (loadingMore || !nextCursor) return;
    const id = fetchIdRef.current;
    const group = selectedGroup && selectedGroup !== 'All' ? selectedGroup : undefined;
    setLoadingMore(true);
    try {
      const data = await apiBrowse(contentType, group, PAGE_SIZE, nextCursor);
      if (fetchIdRef.current !== id) return;
      setChannels(prev => [...prev, ...data.channels]);
      setTotalCount(data.total);
      setNextCursor(data.nextCursor);
    } catch (err) {
      showToast(`Failed to load more: ${err}`);
    } finally {
      if (fetchIdRef.current === id) setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, selectedGroup, contentType, showToast]);

  // Mobile infinite scroll: observe the sentinel near the bottom of the list
  useEffect(() => {
    if (!MOBILE || !nextCursor) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) loadNextPage();
      },
      { rootMargin: '600px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextCursor, loadNextPage]);

  // TV infinite scroll: when the viewport approaches the end of loaded rows, fetch more
  useEffect(() => {
    if (MOBILE || !nextCursor) return;
    const loadedRows = Math.ceil(channels.length / COLUMN_COUNT);
    const visibleEndRow = Math.ceil((scrollOffset + CONTAINER_HEIGHT) / ROW_HEIGHT);
    if (visibleEndRow >= loadedRows - BUFFER) {
      loadNextPage();
    }
  }, [scrollOffset, channels.length, nextCursor, loadNextPage]);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Execute search when debounced query changes
  useEffect(() => {
    if (!debouncedQuery.trim()) return;
    const id = ++fetchIdRef.current;
    let cancelled = false;
    const group = selectedGroup && selectedGroup !== 'All' ? selectedGroup : undefined;
    searchChannelsFn(debouncedQuery, contentType, group)
      .then(results => {
        if (cancelled || fetchIdRef.current !== id) return;
        setChannels(results);
        setTotalCount(results.length);
        setNextCursor(null);
        setIsSearching(false);
        setFocusIndex(0);
        setScrollOffset(0);
      });
    return () => { cancelled = true; };
  }, [debouncedQuery, contentType, selectedGroup, searchChannelsFn]);

  // Fetch EPG for live TV channels — only for IDs we haven't fetched yet
  useEffect(() => {
    if (contentType !== 'livetv' || channels.length === 0) return;
    let cancelled = false;
    const missing = channels.map(ch => ch.id).filter(id => !fetchedEpgIdsRef.current.has(id));
    if (missing.length === 0) return;
    missing.forEach(id => fetchedEpgIdsRef.current.add(id));
    fetchBatchEpg(missing).then(data => {
      if (!cancelled) setEpgMap(prev => ({ ...prev, ...data }));
    });
    return () => { cancelled = true; };
  }, [contentType, channels]);

  const totalRows = Math.ceil(channels.length / COLUMN_COUNT);

  // Compute visible row range (TV only)
  const startRow = MOBILE ? 0 : Math.max(0, Math.floor(scrollOffset / ROW_HEIGHT) - BUFFER);
  const endRow = MOBILE ? totalRows - 1 : Math.min(totalRows - 1, Math.ceil((scrollOffset + CONTAINER_HEIGHT) / ROW_HEIGHT) + BUFFER);

  // Prefetch images for upcoming rows
  useEffect(() => {
    if (MOBILE) return;
    const prefetchStart = endRow + 1;
    const prefetchEnd = Math.min(totalRows - 1, endRow + PREFETCH_ROWS);
    if (prefetchStart > prefetchEnd) return;
    const urls: string[] = [];
    for (let row = prefetchStart; row <= prefetchEnd; row++) {
      for (let col = 0; col < COLUMN_COUNT; col++) {
        const idx = row * COLUMN_COUNT + col;
        if (idx < channels.length && channels[idx].logo) {
          urls.push(channels[idx].logo);
        }
      }
    }
    if (urls.length > 0) prefetchImages(urls);
  }, [endRow, totalRows, channels]);

  // Focus the card at focusIndex after render (TV)
  useEffect(() => {
    if (MOBILE || focusZone !== 'grid') return;
    requestAnimationFrame(() => {
      const grid = gridRef.current;
      if (!grid) return;
      const el = grid.querySelector(`[data-vindex="${focusIndex}"]`) as HTMLElement | null;
      el?.focus({ preventScroll: true });
      markKeyRendered();
    });
  }, [focusIndex, startRow, endRow, channels.length, focusZone]);

  const handleSelect = useCallback(
    (channel: Channel) => {
      // Series containers have no URL — open series detail instead
      if (channel.contentType === 'series' && !channel.url) {
        navigateToSeries(channel);
        return;
      }
      // Movies go to detail page on mobile
      if (MOBILE && channel.contentType === 'movies') {
        navigateToMovie(channel);
        return;
      }
      setChannel(channel);
      navigate('player');
    },
    [setChannel, navigate, navigateToSeries, navigateToMovie]
  );

  const handleGroupSelect = useCallback((groupName: string) => {
    setSelectedGroup(groupName);
    setSearchQuery('');
    setDebouncedQuery('');
    setBrowseState(viewName, { searchQuery: '', selectedGroup: groupName });
  }, [setBrowseState, viewName]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (value.trim()) setIsSearching(true);
    else setIsSearching(false);
    setFocusIndex(0);
    setScrollOffset(0);
    setFocusZone('search');
    setBrowseState(viewName, { searchQuery: value });
  }, [setBrowseState, viewName]);

  // TV keyboard navigation across zones: search, filter button, grid
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (MOBILE) return;
    markKeyDown();
    const count = channels.length;

    if (e.keyCode === KEY_CODES.DOWN) {
      e.preventDefault();
      if (focusZone === 'search') {
        setFocusZone('filter');
        requestAnimationFrame(() => {
          const trigger = document.querySelector('[data-filter-trigger]') as HTMLElement | null;
          trigger?.focus();
        });
      } else if (focusZone === 'filter') {
        if (count > 0) {
          setFocusZone('grid');
          setFocusIndex(0);
          setScrollOffset(0);
        }
      } else if (focusIndex + COLUMN_COUNT < count) {
        const next = focusIndex + COLUMN_COUNT;
        setFocusIndex(next);
        const nextBottom = (Math.floor(next / COLUMN_COUNT) + 1) * ROW_HEIGHT;
        if (nextBottom > scrollOffset + CONTAINER_HEIGHT) {
          setScrollOffset(nextBottom - CONTAINER_HEIGHT);
        }
      }
    } else if (e.keyCode === KEY_CODES.UP) {
      e.preventDefault();
      if (focusZone === 'grid') {
        if (focusIndex - COLUMN_COUNT >= 0) {
          const prev = focusIndex - COLUMN_COUNT;
          setFocusIndex(prev);
          const prevTop = Math.floor(prev / COLUMN_COUNT) * ROW_HEIGHT;
          if (prevTop < scrollOffset) {
            setScrollOffset(prevTop);
          }
        } else {
          setFocusZone('filter');
          requestAnimationFrame(() => {
            const trigger = document.querySelector('[data-filter-trigger]') as HTMLElement | null;
            trigger?.focus();
          });
        }
      } else if (focusZone === 'filter') {
        setFocusZone('search');
        searchRef.current?.focus({ preventScroll: true });
      }
    } else if (e.keyCode === KEY_CODES.RIGHT) {
      if (focusZone === 'search' || focusZone === 'filter') return;
      if (focusIndex % COLUMN_COUNT < COLUMN_COUNT - 1 && focusIndex + 1 < count) {
        e.preventDefault();
        setFocusIndex(focusIndex + 1);
      }
    } else if (e.keyCode === KEY_CODES.LEFT) {
      if (focusZone === 'search' || focusZone === 'filter') return;
      if (focusIndex % COLUMN_COUNT > 0) {
        e.preventDefault();
        setFocusIndex(focusIndex - 1);
      }
    } else if (e.keyCode === KEY_CODES.ENTER) {
      if (focusZone === 'search' || focusZone === 'filter') return;
      e.preventDefault();
      if (focusIndex >= 0 && focusIndex < count) {
        handleSelect(channels[focusIndex]);
      }
    }
  }, [focusZone, focusIndex, channels, scrollOffset, handleSelect]);

  // Re-focus search when this view becomes active (including first mount)
  const isActiveView = useAppStore((s) => s.currentView) === viewName;
  useEffect(() => {
    if (!MOBILE && isActiveView) {
      requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    }
  }, [isActiveView]);

  const label = contentType === 'livetv' ? 'Live TV' : contentType === 'movies' ? 'Movies' : 'Series';

  const showingSearch = !!debouncedQuery.trim();
  const countText = initialLoading
    ? 'Loading...'
    : showingSearch
      ? `${channels.length} result${channels.length !== 1 ? 's' : ''}${isSearching ? ' (searching...)' : ''}`
      : `${channels.length} of ${totalCount} item${totalCount !== 1 ? 's' : ''}${loadingMore ? ' (loading...)' : ''}`;

  const emptyMessage = initialLoading
    ? 'Loading...'
    : isSearching
      ? 'Searching...'
      : searchQuery
        ? 'No matches found.'
        : totalCount === 0 && (!selectedGroup || selectedGroup === 'All')
          ? 'Select a category to browse.'
          : 'No items in this category yet.';

  // Mobile: simple CSS grid, no virtualization
  if (MOBILE) {
    return (
      <div className="flex flex-col gap-3 lg:gap-4 animate-fade-in">
        <div className="sticky top-[calc(-8px-env(safe-area-inset-top,0px))] z-10 bg-dark px-4 pt-[calc(4px+env(safe-area-inset-top,0px))] pb-0 -mx-4 -mt-[calc(8px+env(safe-area-inset-top,0px))] flex flex-col gap-2 lg:static lg:p-0 lg:m-0 lg:z-auto lg:bg-transparent">
          <h1 className="text-20 lg:text-28 font-bold">{label}</h1>
          <div className="flex flex-col lg:flex-row gap-2 lg:gap-3 items-stretch lg:items-start">
            <div className="flex gap-2.5 flex-1">
              <input
                ref={searchRef}
                className="flex-1 py-2.5 px-3.5 lg:py-3 lg:px-4 text-base lg:text-20 bg-surface border-2 border-surface-border rounded-lg text-[#e8eaed] transition-colors duration-200 focus:border-accent placeholder:text-[#444]"
                type="text"
                placeholder={`Search ${label.toLowerCase()}...`}
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
              {searchQuery && (
                <button className="py-2 px-4 bg-surface-border rounded-lg text-base border-2 border-transparent transition-all duration-150 focus:border-accent focus:bg-[#222]" onClick={() => handleSearchChange('')}>
                  X
                </button>
              )}
            </div>
            <FilterDropdown
              categories={categories}
              selectedGroup={selectedGroup}
              onSelect={handleGroupSelect}
            />
          </div>
          <div className="text-13 lg:text-base text-[#555]">{countText}</div>
        </div>
        {contentType === 'livetv' ? (
          /* Live TV: simple list view (no images, full titles visible) */
          <div className="flex flex-col gap-px" ref={gridRef}>
            {channels.length === 0 ? (
              <div className="text-center py-10 lg:py-20 text-base lg:text-22 text-[#444] col-span-full">{emptyMessage}</div>
            ) : (
              channels.map((ch, idx) => (
                <LiveListItem key={ch.id} channel={ch} onSelect={handleSelect} vindex={idx} epgPrograms={epgMap[ch.id]} />
              ))
            )}
          </div>
        ) : (
          <div className="h-auto max-h-none overflow-visible [contain:initial] [content-visibility:visible] grid grid-cols-3 gap-2.5 py-1" ref={gridRef}>
            {channels.length === 0 ? (
              <div className="text-center py-10 lg:py-20 text-base lg:text-22 text-[#444] col-span-full">{emptyMessage}</div>
            ) : (
              channels.map((ch, idx) => (
                <ChannelCard key={ch.id} channel={ch} onSelect={handleSelect} vindex={idx} />
              ))
            )}
          </div>
        )}
        {nextCursor && !showingSearch && (
          <div ref={sentinelRef} className="py-6 text-center text-13 text-[#555]">
            {loadingMore ? 'Loading more...' : ''}
          </div>
        )}
      </div>
    );
  }

  // TV: virtualized grid
  const rows = [];
  for (let row = startRow; row <= endRow; row++) {
    const items = [];
    for (let col = 0; col < COLUMN_COUNT; col++) {
      const idx = row * COLUMN_COUNT + col;
      if (idx < channels.length) {
        items.push(
          <ChannelCard
            key={channels[idx].id}
            channel={channels[idx]}
            onSelect={handleSelect}
            vindex={idx}
          />
        );
      }
    }
    rows.push(
      <div
        key={row}
        className="[contain:layout_style_paint]"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          transform: `translateY(${row * ROW_HEIGHT}px)`,
          height: ROW_HEIGHT,
          display: 'grid',
          gridTemplateColumns: `repeat(${COLUMN_COUNT}, 1fr)`,
          gap: '14px',
          alignContent: 'start',
          contain: 'strict',
        }}
      >
        {items}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 lg:gap-4 animate-fade-in" onKeyDown={handleKeyDown}>
      <h1 className="text-20 lg:text-28 font-bold">{label}</h1>
      <div className="flex flex-col lg:flex-row gap-2 lg:gap-3 items-stretch lg:items-start">
        <div className="flex gap-2.5 flex-1">
          <input
            ref={searchRef}
            className="flex-1 py-2.5 px-3.5 lg:py-3 lg:px-4 text-base lg:text-20 bg-surface border-2 border-surface-border rounded-lg text-[#e8eaed] transition-colors duration-200 focus:border-accent placeholder:text-[#444]"
            type="text"
            placeholder={`Search ${label.toLowerCase()}...`}
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            tabIndex={0}
          />
          {searchQuery && (
            <button
              className="py-2 px-4 bg-surface-border rounded-lg text-base border-2 border-transparent transition-all duration-150 focus:border-accent focus:bg-[#222]"
              onClick={() => handleSearchChange('')}
              tabIndex={-1}
            >
              X
            </button>
          )}
        </div>
        <FilterDropdown
          categories={categories}
          selectedGroup={selectedGroup}
          onSelect={handleGroupSelect}
        />
      </div>
      <div className="text-13 lg:text-base text-[#555]">{countText}</div>
      <div className="h-[900px] overflow-hidden relative [contain:strict] py-2 px-1 [content-visibility:auto]" ref={gridRef}>
        {channels.length === 0 ? (
          <div className="text-center py-10 lg:py-20 text-base lg:text-22 text-[#444] col-span-full">{emptyMessage}</div>
        ) : (
          <div style={{ height: totalRows * ROW_HEIGHT, position: 'relative' }}>
            {rows}
          </div>
        )}
      </div>
    </div>
  );
}
