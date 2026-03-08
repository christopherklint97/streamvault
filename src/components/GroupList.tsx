import { useState, useEffect, useCallback, useRef } from 'react';
import type { ContentType } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { useAppStore } from '../stores/appStore';
import FocusZone from './FocusZone';

interface GroupListProps {
  contentType: ContentType;
}

const BATCH_SIZE = 40;

export default function GroupList({ contentType }: GroupListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const categories = useChannelStore((s) => s.categories);
  const fetchCategories = useChannelStore((s) => s.fetchCategories);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const selectGroup = useAppStore((s) => s.selectGroup);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCategories(contentType);
  }, [contentType, fetchCategories]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setVisibleCount(BATCH_SIZE);
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

  // Load more when focus reaches the "Load More" button
  const handleScrollFocus = useCallback((e: React.FocusEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.group-list__items')) {
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, []);

  const label = contentType === 'livetv' ? 'Live TV' : contentType === 'movies' ? 'Movies' : 'Series';

  return (
    <FocusZone className="group-list">
      <h1 className="group-list__title">{label}</h1>
      <div className="group-list__search">
        <input
          className="channel-list__search-input"
          type="text"
          placeholder={`Search ${label.toLowerCase()} categories...`}
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          data-focusable
          tabIndex={0}
        />
        {searchQuery && (
          <button
            className="channel-list__search-clear"
            onClick={() => handleSearchChange('')}
            data-focusable
            tabIndex={0}
          >
            X
          </button>
        )}
      </div>
      <div className="group-list__count">
        {filtered.length} categor{filtered.length !== 1 ? 'ies' : 'y'}
      </div>
      <div className="group-list__items" ref={listRef} onFocus={handleScrollFocus}>
        {displayed.length === 0 ? (
          <div className="channel-list__empty">
            {categories.length === 0 ? 'No categories found. Sync in Settings.' : 'No matching categories.'}
          </div>
        ) : (
          displayed.map((cat) => (
            <button
              key={cat.id}
              className="group-list__item"
              data-focusable
              tabIndex={0}
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
            data-focusable
            tabIndex={0}
            onClick={handleLoadMore}
          >
            Load more ({filtered.length - visibleCount} remaining)
          </button>
        )}
      </div>
    </FocusZone>
  );
}
