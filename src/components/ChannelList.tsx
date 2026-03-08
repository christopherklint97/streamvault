import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Channel } from '../types';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import ChannelCard from './ChannelCard';
import VirtualGrid from './VirtualGrid';
import FocusZone from './FocusZone';

interface ChannelListProps {
  channels: Channel[];
  groupName: string;
}

const COLUMN_COUNT = 5;

export default function ChannelList({ channels, groupName }: ChannelListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
  const gridContainerRef = useRef<HTMLDivElement>(null);

  // Client-side filter within the loaded group
  const displayChannels = useMemo(() => {
    if (!searchQuery.trim()) return channels;
    const q = searchQuery.toLowerCase();
    return channels.filter((ch) => ch.name.toLowerCase().includes(q));
  }, [channels, searchQuery]);

  // Re-focus first card when channels change
  const prevCountRef = useRef(channels.length);
  useEffect(() => {
    if (channels.length !== prevCountRef.current) {
      prevCountRef.current = channels.length;
      requestAnimationFrame(() => {
        const container = gridContainerRef.current;
        if (!container) return;
        const firstCard = container.querySelector('[data-focusable]') as HTMLElement | null;
        firstCard?.focus({ preventScroll: true });
      });
    }
  }, [channels.length]);

  const handleSelect = useCallback(
    (channel: Channel) => {
      setChannel(channel);
      navigate('player');
    },
    [setChannel, navigate]
  );

  return (
    <FocusZone className="channel-list">
      <h1 className="channel-list__title">{groupName}</h1>
      <div className="channel-list__search">
        <input
          className="channel-list__search-input"
          type="text"
          placeholder={`Search in ${groupName}...`}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          data-focusable
          tabIndex={0}
        />
        {searchQuery && (
          <button
            className="channel-list__search-clear"
            onClick={() => setSearchQuery('')}
            data-focusable
            tabIndex={0}
          >
            X
          </button>
        )}
      </div>
      <div className="channel-list__count">
        {`${displayChannels.length} item${displayChannels.length !== 1 ? 's' : ''}`}
      </div>
      <div ref={gridContainerRef}>
        {displayChannels.length === 0 ? (
          <div className="channel-list__empty">
            {searchQuery ? 'No matches found.' : 'Loading...'}
          </div>
        ) : (
          <VirtualGrid
            itemCount={displayChannels.length}
            columnCount={COLUMN_COUNT}
            rowHeight={240}
            containerHeight={800}
            renderItem={(index: number) => {
              const channel = displayChannels[index];
              return (
                <ChannelCard
                  key={channel.id}
                  channel={channel}
                  isFocused={false}
                  onSelect={() => handleSelect(channel)}
                />
              );
            }}
          />
        )}
      </div>
    </FocusZone>
  );
}
