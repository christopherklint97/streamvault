import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Channel, ContentType, Category } from '../types';
import { usePlayerStore } from '../stores/playerStore';
import { useChannelStore, SAME_ORIGIN } from '../stores/channelStore';
import { useAppStore } from '../stores/appStore';
import { KEY_CODES } from '../utils/keys';
import { prefetchImages } from '../utils/image-pool';
import { markKeyDown, markKeyRendered } from '../utils/perf-monitor';
import { isMobile } from '../utils/platform';
import ChannelCard from './ChannelCard';
import { useFavoritesStore } from '../stores/favoritesStore';

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
    const items = list.querySelectorAll('.filter-dropdown__item') as NodeListOf<HTMLElement>;
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
    <div className="filter-dropdown" ref={containerRef} onKeyDown={handleKeyDown}>
      <button
        className={`filter-dropdown__trigger${open ? ' filter-dropdown__trigger--open' : ''}`}
        onClick={handleToggle}
        tabIndex={0}
      >
        <span className="filter-dropdown__label">{label}</span>
        <span className="filter-dropdown__arrow">{open ? '\u25B2' : '\u25BC'}</span>
      </button>

      {open && (
        <div className="filter-dropdown__panel">
          <input
            ref={inputRef}
            className="filter-dropdown__search"
            type="text"
            placeholder="Search categories..."
            value={filterQuery}
            onChange={e => { setFilterQuery(e.target.value); setFocusIdx(-1); }}
          />
          <div className="filter-dropdown__list" ref={listRef}>
            <button
              className={`filter-dropdown__item${selectedGroup === 'All' || !selectedGroup ? ' filter-dropdown__item--active' : ''}${focusIdx === 0 ? ' filter-dropdown__item--focused' : ''}`}
              onClick={() => handleSelect('All')}
            >
              All categories
            </button>
            {filtered.map((cat, i) => (
              <button
                key={cat.id}
                className={`filter-dropdown__item${selectedGroup === cat.name ? ' filter-dropdown__item--active' : ''}${focusIdx === i + 1 ? ' filter-dropdown__item--focused' : ''}`}
                onClick={() => handleSelect(cat.name)}
              >
                <span className="filter-dropdown__item-name">{cat.name}</span>
                {cat.stream_count > 0 && (
                  <span className="filter-dropdown__item-count">{cat.stream_count}</span>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="filter-dropdown__empty">No matching categories</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Live TV List Item (mobile) ----------

function LiveListItem({ channel, onSelect, vindex }: { channel: Channel; onSelect: (ch: Channel) => void; vindex: number }) {
  const isFav = useFavoritesStore((s) => s.favoriteIds.has(channel.id));
  const toggle = useFavoritesStore((s) => s.toggleFavorite);
  return (
    <div className="channel-list__live-item" data-vindex={vindex}>
      <button className="channel-list__live-main" onClick={() => onSelect(channel)}>
        <span className="channel-list__live-name">{channel.name}</span>
      </button>
      <button
        className={`channel-list__live-fav${isFav ? ' channel-list__live-fav--active' : ''}`}
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  const categories = useChannelStore((s) => s.categories);
  const fetchCategories = useChannelStore((s) => s.fetchCategories);
  const searchChannelsFn = useChannelStore((s) => s.searchChannels);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
  const navigateToSeries = useAppStore((s) => s.navigateToSeries);
  const navigateToMovie = useAppStore((s) => s.navigateToMovie);

  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fetchIdRef = useRef(0); // to discard stale responses

  // Fetch categories on mount
  useEffect(() => {
    fetchCategories(contentType);
  }, [contentType, fetchCategories]);

  // Load initial page of channels (alphabetical, first 20)
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
    }).catch(() => {
      if (cancelled || fetchIdRef.current !== id) return;
      setInitialLoading(false);
    });
    return () => { cancelled = true; };
  }, [contentType, selectedGroup, categories]);

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

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      const group = selectedGroup && selectedGroup !== 'All' ? selectedGroup : undefined;
      const data = await apiBrowse(contentType, group, PAGE_SIZE, nextCursor);
      setChannels(prev => [...prev, ...data.channels]);
      setTotalCount(data.total);
      setNextCursor(data.nextCursor);
    } catch { /* ignore */ }
    setLoadingMore(false);
  }, [loadingMore, nextCursor, selectedGroup, contentType]);

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
          const trigger = document.querySelector('.filter-dropdown__trigger') as HTMLElement | null;
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
            const trigger = document.querySelector('.filter-dropdown__trigger') as HTMLElement | null;
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

  // Auto-focus search on mount
  useEffect(() => {
    if (!MOBILE) {
      requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    }
  }, []);

  const label = contentType === 'livetv' ? 'Live TV' : contentType === 'movies' ? 'Movies' : 'Series';

  const showingSearch = !!debouncedQuery.trim();
  const countText = initialLoading
    ? 'Loading...'
    : showingSearch
      ? `${channels.length} result${channels.length !== 1 ? 's' : ''}${isSearching ? ' (searching...)' : ''}`
      : `${channels.length} of ${totalCount} item${totalCount !== 1 ? 's' : ''}`;

  const emptyMessage = initialLoading
    ? 'Loading...'
    : isSearching
      ? 'Searching...'
      : searchQuery
        ? 'No matches found.'
        : totalCount === 0 && (!selectedGroup || selectedGroup === 'All')
          ? 'Select a category to browse.'
          : 'No items in this category yet.';

  const remaining = totalCount - channels.length;

  // Mobile: simple CSS grid, no virtualization
  if (MOBILE) {
    return (
      <div className="channel-list">
        <div className="channel-list__sticky-header">
          <h1 className="channel-list__title">{label}</h1>
          <div className="channel-list__search-row">
            <div className="channel-list__search">
              <input
                ref={searchRef}
                className="channel-list__search-input"
                type="text"
                placeholder={`Search ${label.toLowerCase()}...`}
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
              {searchQuery && (
                <button className="channel-list__search-clear" onClick={() => handleSearchChange('')}>
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
          <div className="channel-list__count">{countText}</div>
        </div>
        {contentType === 'livetv' ? (
          /* Live TV: simple list view (no images, full titles visible) */
          <div className="channel-list__live-list" ref={gridRef}>
            {channels.length === 0 ? (
              <div className="channel-list__empty">{emptyMessage}</div>
            ) : (
              channels.map((ch, idx) => (
                <LiveListItem key={ch.id} channel={ch} onSelect={handleSelect} vindex={idx} />
              ))
            )}
          </div>
        ) : (
          <div className="channel-list__grid channel-list__grid--mobile" ref={gridRef}>
            {channels.length === 0 ? (
              <div className="channel-list__empty">{emptyMessage}</div>
            ) : (
              channels.map((ch, idx) => (
                <ChannelCard key={ch.id} channel={ch} onSelect={handleSelect} vindex={idx} />
              ))
            )}
          </div>
        )}
        {nextCursor && !showingSearch && (
          <button className="channel-list__load-more" onClick={handleLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading...' : `Load more (${remaining} remaining)`}
          </button>
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
        className="channel-list__row"
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
    <div className="channel-list" onKeyDown={handleKeyDown}>
      <h1 className="channel-list__title">{label}</h1>
      <div className="channel-list__search-row">
        <div className="channel-list__search">
          <input
            ref={searchRef}
            className="channel-list__search-input"
            type="text"
            placeholder={`Search ${label.toLowerCase()}...`}
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            tabIndex={0}
          />
          {searchQuery && (
            <button
              className="channel-list__search-clear"
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
      <div className="channel-list__count">{countText}</div>
      <div className="channel-list__grid" ref={gridRef}>
        {channels.length === 0 ? (
          <div className="channel-list__empty">{emptyMessage}</div>
        ) : (
          <div style={{ height: totalRows * ROW_HEIGHT, position: 'relative' }}>
            {rows}
          </div>
        )}
      </div>
      {nextCursor && !showingSearch && (
        <button className="channel-list__load-more" onClick={handleLoadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading...' : `Load more (${remaining} remaining)`}
        </button>
      )}
    </div>
  );
}
