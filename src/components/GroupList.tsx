import { useState, useEffect, useCallback, useRef } from 'react';
import type { ContentType } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { useAppStore } from '../stores/appStore';
import { KEY_CODES } from '../utils/keys';
import { cn } from '../utils/cn';

interface GroupListProps {
  contentType: ContentType;
}

const BATCH_SIZE = 40;

export default function GroupList({ contentType }: GroupListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const [focusIndex, setFocusIndex] = useState(-1);
  const categories = useChannelStore((s) => s.categories);
  const fetchCategories = useChannelStore((s) => s.fetchCategories);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const selectGroup = useAppStore((s) => s.selectGroup);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCategories(contentType);
  }, [contentType, fetchCategories]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setVisibleCount(BATCH_SIZE);
    setFocusIndex(-1);
  }, []);

  const filtered = searchQuery.trim()
    ? categories.filter((c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : categories;

  const displayed = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visibleCount;

  const handleSelectGroup = useCallback(
    (groupName: string) => {
      selectGroup(groupName);
      fetchChannels(groupName);
    },
    [selectGroup, fetchChannels]
  );

  const handleLoadMore = useCallback(() => {
    setVisibleCount((prev) => prev + BATCH_SIZE);
  }, []);

  // Focus the item at the given index
  const focusItem = useCallback((index: number) => {
    const items = itemsRef.current;
    if (!items) return;
    const buttons = items.querySelectorAll('[data-group-item]') as NodeListOf<HTMLElement>;
    if (index >= 0 && index < buttons.length) {
      buttons[index].focus({ preventScroll: true });
      // Manual scroll - cheap, no smooth animation
      const item = buttons[index];
      const container = items;
      const itemTop = item.offsetTop;
      const itemBottom = itemTop + item.offsetHeight;
      if (itemTop < container.scrollTop) {
        container.scrollTop = itemTop - 8;
      } else if (itemBottom > container.scrollTop + container.clientHeight) {
        container.scrollTop = itemBottom - container.clientHeight + 8;
      }
    }
  }, []);

  // Keyboard navigation - simple index-based, no getBoundingClientRect
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const active = document.activeElement as HTMLElement;
    const isOnSearch = active === searchRef.current;
    const itemCount = displayed.length + (hasMore ? 1 : 0); // +1 for load more button

    if (e.keyCode === KEY_CODES.DOWN) {
      e.preventDefault();
      if (isOnSearch) {
        // Move from search to first item
        if (itemCount > 0) {
          setFocusIndex(0);
          focusItem(0);
        }
      } else if (focusIndex < displayed.length - 1) {
        const next = focusIndex + 1;
        setFocusIndex(next);
        focusItem(next);
      } else if (focusIndex === displayed.length - 1 && hasMore) {
        // Focus load more button
        const loadMore = itemsRef.current?.querySelector('[data-group-loadmore]') as HTMLElement | null;
        loadMore?.focus({ preventScroll: true });
        setFocusIndex(displayed.length);
      }
    } else if (e.keyCode === KEY_CODES.UP) {
      e.preventDefault();
      if (isOnSearch) return;
      if (focusIndex <= 0) {
        // Move back to search
        setFocusIndex(-1);
        searchRef.current?.focus({ preventScroll: true });
      } else {
        const prev = focusIndex - 1;
        setFocusIndex(prev);
        focusItem(prev);
      }
    } else if (e.keyCode === KEY_CODES.ENTER) {
      if (isOnSearch) return; // let input handle it
      e.preventDefault();
      if (focusIndex >= 0 && focusIndex < displayed.length) {
        handleSelectGroup(displayed[focusIndex].name);
      } else if (focusIndex === displayed.length && hasMore) {
        handleLoadMore();
      }
    } else if (e.keyCode === KEY_CODES.LEFT) {
      if (isOnSearch) return; // cursor movement
      // Let it bubble to App.tsx → sidebar
    }
  }, [focusIndex, displayed, hasMore, focusItem, handleSelectGroup, handleLoadMore]);

  // Auto-focus search on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      searchRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const label = contentType === 'livetv' ? 'Live TV' : contentType === 'movies' ? 'Movies' : 'Series';

  return (
    <div className="flex flex-col gap-3 lg:gap-4 animate-fade-in" ref={containerRef} onKeyDown={handleKeyDown}>
      <h1 className="text-20 lg:text-28 font-bold">{label}</h1>
      <div className="flex gap-2.5">
        <input
          ref={searchRef}
          className="flex-1 py-2.5 px-3.5 lg:py-3 lg:px-4 text-base lg:text-20 bg-surface border-2 border-surface-border rounded-lg text-[#e8eaed] transition-colors duration-200 focus:border-accent placeholder:text-[#444]"
          type="text"
          placeholder={`Search ${label.toLowerCase()} categories...`}
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          tabIndex={0}
        />
        {searchQuery && (
          <button
            className="py-2 px-4 bg-surface-border rounded-lg text-base border-2 border-transparent transition-all duration-150 focus:border-accent focus:bg-[#222]"
            onClick={() => handleSearchChange('')}
            tabIndex={0}
          >
            X
          </button>
        )}
      </div>
      <div className="text-base text-[#555]">
        {filtered.length} categor{filtered.length !== 1 ? 'ies' : 'y'}
      </div>
      <div className="flex flex-col gap-1 overflow-y-visible py-1 lg:max-h-[820px] lg:overflow-y-auto lg:[contain:content] lg:[will-change:scroll-position]" ref={itemsRef}>
        {displayed.length === 0 ? (
          <div className="text-center py-10 lg:py-20 text-base lg:text-22 text-[#444] col-span-full">
            {categories.length === 0 ? 'No categories found. Sync in Settings.' : 'No matching categories.'}
          </div>
        ) : (
          displayed.map((cat, i) => (
            <button
              key={cat.id}
              className={cn(
                'group flex items-center gap-3 py-3.5 px-4 lg:py-4 lg:px-5 bg-surface border-2 border-transparent rounded-lg text-left [contain:layout_style_paint] transition-all duration-150 tap-none focus:border-accent focus:bg-surface-hover lg:focus:scale-[1.01]',
                focusIndex === i && 'border-accent bg-surface-hover lg:scale-[1.01]'
              )}
              data-group-item
              tabIndex={focusIndex === i ? 0 : -1}
              onClick={() => handleSelectGroup(cat.name)}
            >
              <span className="flex-1 text-15 lg:text-20 font-semibold">{cat.name}</span>
              <span className="text-base text-[#555]">
                {cat.stream_count > 0 ? cat.stream_count : ''}
              </span>
              <span className="text-24 text-[#333] transition-all duration-150 group-focus:text-accent group-focus:translate-x-0.5">{'\u203A'}</span>
            </button>
          ))
        )}
        {hasMore && (
          <button
            className="py-3 bg-surface border-2 border-transparent rounded-lg text-[#666] text-center text-17 transition-all duration-150 focus:border-accent focus:bg-surface-hover"
            data-group-loadmore
            tabIndex={focusIndex === displayed.length ? 0 : -1}
            onClick={handleLoadMore}
          >
            Load more ({filtered.length - visibleCount} remaining)
          </button>
        )}
      </div>
    </div>
  );
}
