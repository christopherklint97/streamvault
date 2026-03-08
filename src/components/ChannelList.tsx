import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Channel } from '../types';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { KEY_CODES } from '../utils/keys';
import ChannelCard from './ChannelCard';

interface ChannelListProps {
  channels: Channel[];
  groupName: string;
}

const COLUMN_COUNT = 5;
const BATCH_SIZE = 50;

export default function ChannelList({ channels, groupName }: ChannelListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const [focusIndex, setFocusIndex] = useState(0);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusOnSearch = useRef(false);

  const displayChannels = useMemo(() => {
    if (!searchQuery.trim()) return channels;
    const q = searchQuery.toLowerCase();
    return channels.filter((ch) => ch.name.toLowerCase().includes(q));
  }, [channels, searchQuery]);

  const displayed = displayChannels.slice(0, visibleCount);
  const hasMore = displayChannels.length > visibleCount;

  // Focus first card when channels load
  useEffect(() => {
    if (channels.length > 0 && !focusOnSearch.current) {
      requestAnimationFrame(() => {
        const grid = gridRef.current;
        if (!grid) return;
        const first = grid.querySelector('[data-focusable]') as HTMLElement | null;
        first?.focus({ preventScroll: true });
      });
    }
  }, [channels.length]);

  const focusCard = useCallback((index: number) => {
    const grid = gridRef.current;
    if (!grid) return;
    const cards = grid.querySelectorAll('[data-focusable]') as NodeListOf<HTMLElement>;
    if (index >= 0 && index < cards.length) {
      cards[index].focus({ preventScroll: true });
      // Manual scroll
      const card = cards[index];
      const parent = grid;
      const cardTop = card.offsetTop;
      const cardBottom = cardTop + card.offsetHeight;
      if (cardTop < parent.scrollTop) {
        parent.scrollTop = cardTop - 8;
      } else if (cardBottom > parent.scrollTop + parent.clientHeight) {
        parent.scrollTop = cardBottom - parent.clientHeight + 8;
      }
    }
  }, []);

  const handleSelect = useCallback(
    (channel: Channel) => {
      setChannel(channel);
      navigate('player');
    },
    [setChannel, navigate]
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const active = document.activeElement as HTMLElement;
    const isOnSearch = active === searchRef.current;
    const count = displayed.length;

    if (e.keyCode === KEY_CODES.DOWN) {
      e.preventDefault();
      if (isOnSearch) {
        if (count > 0) {
          focusOnSearch.current = false;
          setFocusIndex(0);
          focusCard(0);
        }
      } else if (focusIndex + COLUMN_COUNT < count) {
        const next = focusIndex + COLUMN_COUNT;
        setFocusIndex(next);
        focusCard(next);
      } else if (hasMore) {
        setVisibleCount((prev) => prev + BATCH_SIZE);
      }
    } else if (e.keyCode === KEY_CODES.UP) {
      e.preventDefault();
      if (isOnSearch) return;
      if (focusIndex - COLUMN_COUNT >= 0) {
        const prev = focusIndex - COLUMN_COUNT;
        setFocusIndex(prev);
        focusCard(prev);
      } else {
        // Move to search
        focusOnSearch.current = true;
        setFocusIndex(0);
        searchRef.current?.focus({ preventScroll: true });
      }
    } else if (e.keyCode === KEY_CODES.RIGHT) {
      if (isOnSearch) return; // cursor movement
      e.preventDefault();
      if (focusIndex % COLUMN_COUNT < COLUMN_COUNT - 1 && focusIndex + 1 < count) {
        const next = focusIndex + 1;
        setFocusIndex(next);
        focusCard(next);
      }
    } else if (e.keyCode === KEY_CODES.LEFT) {
      if (isOnSearch) return; // cursor movement
      if (focusIndex % COLUMN_COUNT > 0) {
        e.preventDefault();
        const prev = focusIndex - 1;
        setFocusIndex(prev);
        focusCard(prev);
      }
      // else: let it bubble to App.tsx → sidebar
    } else if (e.keyCode === KEY_CODES.ENTER) {
      if (isOnSearch) return;
      e.preventDefault();
      if (focusIndex >= 0 && focusIndex < count) {
        handleSelect(displayed[focusIndex]);
      }
    }
  }, [focusIndex, displayed, hasMore, focusCard, handleSelect]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setVisibleCount(BATCH_SIZE);
    setFocusIndex(0);
    focusOnSearch.current = true;
  }, []);

  return (
    <div className="channel-list" ref={containerRef} onKeyDown={handleKeyDown}>
      <h1 className="channel-list__title">{groupName}</h1>
      <div className="channel-list__search">
        <input
          ref={searchRef}
          className="channel-list__search-input"
          type="text"
          placeholder={`Search in ${groupName}...`}
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
      <div className="channel-list__count">
        {displayChannels.length} item{displayChannels.length !== 1 ? 's' : ''}
      </div>
      <div className="channel-list__grid" ref={gridRef}>
        {displayed.length === 0 ? (
          <div className="channel-list__empty">
            {searchQuery ? 'No matches found.' : 'Loading...'}
          </div>
        ) : (
          displayed.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              onSelect={() => handleSelect(channel)}
            />
          ))
        )}
        {hasMore && (
          <button
            className="channel-list__load-more"
            tabIndex={-1}
            onClick={() => setVisibleCount((prev) => prev + BATCH_SIZE)}
          >
            Load more ({displayChannels.length - visibleCount} remaining)
          </button>
        )}
      </div>
    </div>
  );
}
