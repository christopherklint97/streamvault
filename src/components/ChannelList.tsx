import { useState, useRef, useCallback } from 'react';
import type { Channel } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { useFocusNavigation } from '../hooks/useFocusNavigation';
import { searchChannels } from '../services/channel-service';
import { KEY_CODES } from '../utils/keys';
import ChannelCard from './ChannelCard';
import VirtualGrid from './VirtualGrid';

interface ChannelListProps {
  channels: Channel[];
}

const COLUMN_COUNT = 5;

export default function ChannelList({ channels }: ChannelListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const groups = useChannelStore((s) => s.groups);
  const regions = useChannelStore((s) => s.regions);
  const selectedGroup = useChannelStore((s) => s.selectedGroup);
  const selectedRegion = useChannelStore((s) => s.selectedRegion);
  const setSelectedGroup = useChannelStore((s) => s.setSelectedGroup);
  const setSelectedRegion = useChannelStore((s) => s.setSelectedRegion);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);

  const filteredChannels = searchChannels(
    channels.filter((ch) => {
      const groupMatch = selectedGroup === 'All' || ch.group === selectedGroup;
      const regionMatch = selectedRegion === 'All' || ch.region === selectedRegion;
      return groupMatch && regionMatch;
    }),
    searchQuery
  );

  const { focusIndex } = useFocusNavigation(containerRef, COLUMN_COUNT);

  const handleSelect = useCallback(
    (channel: Channel) => {
      setChannel(channel);
      navigate('player');
    },
    [setChannel, navigate]
  );

  const handleFilterKeyDown = (e: React.KeyboardEvent, type: 'group' | 'region', values: string[], current: string) => {
    if (e.keyCode === KEY_CODES.LEFT || e.keyCode === KEY_CODES.RIGHT) {
      e.preventDefault();
      const idx = values.indexOf(current);
      const next = e.keyCode === KEY_CODES.RIGHT
        ? values[(idx + 1) % values.length]
        : values[(idx - 1 + values.length) % values.length];
      if (type === 'group') setSelectedGroup(next);
      else setSelectedRegion(next);
    }
  };

  return (
    <div className="channel-list">
      <div className="channel-list__search">
        <input
          className="channel-list__search-input"
          type="text"
          placeholder="Search channels..."
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
      <div className="channel-list__filters">
        <div className="filter-row">
          <span className="filter-label">Group:</span>
          <div className="filter-chips">
            {groups.map((group) => (
              <button
                key={group}
                className={`filter-chip${selectedGroup === group ? ' filter-chip--active' : ''}`}
                data-focusable
                tabIndex={0}
                onClick={() => setSelectedGroup(group)}
                onKeyDown={(e) => handleFilterKeyDown(e, 'group', groups, selectedGroup)}
              >
                {group}
              </button>
            ))}
          </div>
        </div>
        {regions.length > 1 && (
          <div className="filter-row">
            <span className="filter-label">Region:</span>
            <div className="filter-chips">
              {regions.map((region) => (
                <button
                  key={region}
                  className={`filter-chip${selectedRegion === region ? ' filter-chip--active' : ''}`}
                  data-focusable
                  tabIndex={0}
                  onClick={() => setSelectedRegion(region)}
                  onKeyDown={(e) => handleFilterKeyDown(e, 'region', regions, selectedRegion)}
                >
                  {region}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="channel-list__count">
        {filteredChannels.length} channel{filteredChannels.length !== 1 ? 's' : ''}
      </div>
      {filteredChannels.length === 0 ? (
        <div className="channel-list__empty">No channels found</div>
      ) : (
        <VirtualGrid
          itemCount={filteredChannels.length}
          columnCount={COLUMN_COUNT}
          rowHeight={220}
          containerHeight={800}
          focusIndex={focusIndex}
          renderItem={(index: number) => {
            const channel = filteredChannels[index];
            return (
              <ChannelCard
                key={channel.id}
                channel={channel}
                isFocused={index === focusIndex}
                onSelect={() => handleSelect(channel)}
              />
            );
          }}
        />
      )}
    </div>
  );
}
