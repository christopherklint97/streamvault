import { useState, useEffect, useCallback, useRef } from 'react';
import type { ContentType } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { useAppStore } from '../stores/appStore';
import { KEY_CODES } from '../utils/keys';

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
    const buttons = items.querySelectorAll('.group-list__item') as NodeListOf<HTMLElement>;
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
        const loadMore = itemsRef.current?.querySelector('.group-list__load-more') as HTMLElement | null;
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
    <div className="group-list" ref={containerRef} onKeyDown={handleKeyDown}>
      <h1 className="group-list__title">{label}</h1>
      <div className="group-list__search">
        <input
          ref={searchRef}
          className="channel-list__search-input"
          type="text"
          placeholder={`Search ${label.toLowerCase()} categories...`}
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          tabIndex={0}
        />
        {searchQuery && (
          <button
            className="channel-list__search-clear"
            onClick={() => handleSearchChange('')}
            tabIndex={0}
          >
            X
          </button>
        )}
      </div>
      <div className="group-list__count">
        {filtered.length} categor{filtered.length !== 1 ? 'ies' : 'y'}
      </div>
      <div className="group-list__items" ref={itemsRef}>
        {displayed.length === 0 ? (
          <div className="channel-list__empty">
            {categories.length === 0 ? 'No categories found. Sync in Settings.' : 'No matching categories.'}
          </div>
        ) : (
          displayed.map((cat, i) => (
            <button
              key={cat.id}
              className={`group-list__item${focusIndex === i ? ' group-list__item--focused' : ''}`}
              tabIndex={focusIndex === i ? 0 : -1}
              onClick={() => handleSelectGroup(cat.name)}
            >
              <span className="group-list__item-name">{cat.name}</span>
              <span className="group-list__item-count">
                {cat.stream_count > 0 ? cat.stream_count : ''}
              </span>
              <span className="group-list__item-arrow">{'\u203A'}</span>
            </button>
          ))
        )}
        {hasMore && (
          <button
            className="group-list__load-more"
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
