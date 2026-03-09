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
const ROW_HEIGHT = 200;
const CONTAINER_HEIGHT = 800;
const BUFFER = 2;

export default function ChannelList({ channels, groupName }: ChannelListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [focusIndex, setFocusIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusOnSearch = useRef(false);

  const displayChannels = useMemo(() => {
    if (!searchQuery.trim()) return channels;
    const q = searchQuery.toLowerCase();
    return channels.filter((ch) => ch.name.toLowerCase().includes(q));
  }, [channels, searchQuery]);

  const totalRows = Math.ceil(displayChannels.length / COLUMN_COUNT);

  // Compute visible row range
  const startRow = Math.max(0, Math.floor(scrollOffset / ROW_HEIGHT) - BUFFER);
  const endRow = Math.min(totalRows - 1, Math.ceil((scrollOffset + CONTAINER_HEIGHT) / ROW_HEIGHT) + BUFFER);

  // Focus the card at focusIndex after render
  useEffect(() => {
    if (focusOnSearch.current) return;
    requestAnimationFrame(() => {
      const grid = gridRef.current;
      if (!grid) return;
      const el = grid.querySelector(`[data-vindex="${focusIndex}"]`) as HTMLElement | null;
      el?.focus({ preventScroll: true });
    });
  }, [focusIndex, startRow, endRow, channels.length]);

  const handleSelect = useCallback(
    (channel: Channel) => {
      setChannel(channel);
      navigate('player');
    },
    [setChannel, navigate]
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const isOnSearch = document.activeElement === searchRef.current;
    const count = displayChannels.length;

    if (e.keyCode === KEY_CODES.DOWN) {
      e.preventDefault();
      if (isOnSearch) {
        if (count > 0) {
          focusOnSearch.current = false;
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
      if (isOnSearch) return;
      if (focusIndex - COLUMN_COUNT >= 0) {
        const prev = focusIndex - COLUMN_COUNT;
        setFocusIndex(prev);
        const prevTop = Math.floor(prev / COLUMN_COUNT) * ROW_HEIGHT;
        if (prevTop < scrollOffset) {
          setScrollOffset(prevTop);
        }
      } else {
        focusOnSearch.current = true;
        setFocusIndex(0);
        searchRef.current?.focus({ preventScroll: true });
      }
    } else if (e.keyCode === KEY_CODES.RIGHT) {
      if (isOnSearch) return;
      e.preventDefault();
      if (focusIndex % COLUMN_COUNT < COLUMN_COUNT - 1 && focusIndex + 1 < count) {
        setFocusIndex(focusIndex + 1);
      }
    } else if (e.keyCode === KEY_CODES.LEFT) {
      if (isOnSearch) return;
      if (focusIndex % COLUMN_COUNT > 0) {
        e.preventDefault();
        setFocusIndex(focusIndex - 1);
      }
      // else: let it bubble to App.tsx -> sidebar
    } else if (e.keyCode === KEY_CODES.ENTER) {
      if (isOnSearch) return;
      e.preventDefault();
      if (focusIndex >= 0 && focusIndex < count) {
        handleSelect(displayChannels[focusIndex]);
      }
    }
  }, [focusIndex, displayChannels, scrollOffset, handleSelect]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setFocusIndex(0);
    setScrollOffset(0);
    focusOnSearch.current = true;
  }, []);

  // Build only the visible rows
  const rows = [];
  for (let row = startRow; row <= endRow; row++) {
    const items = [];
    for (let col = 0; col < COLUMN_COUNT; col++) {
      const idx = row * COLUMN_COUNT + col;
      if (idx < displayChannels.length) {
        items.push(
          <ChannelCard
            key={displayChannels[idx].id}
            channel={displayChannels[idx]}
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
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: '16px',
          alignContent: 'start',
        }}
      >
        {items}
      </div>
    );
  }

  return (
    <div className="channel-list" onKeyDown={handleKeyDown}>
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
      <div
        className="channel-list__grid"
        ref={gridRef}
      >
        {displayChannels.length === 0 ? (
          <div className="channel-list__empty">
            {searchQuery ? 'No matches found.' : 'Loading...'}
          </div>
        ) : (
          <div style={{ height: totalRows * ROW_HEIGHT, position: 'relative' }}>
            {rows}
          </div>
        )}
      </div>
    </div>
  );
}
