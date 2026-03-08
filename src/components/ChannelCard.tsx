import { memo, useCallback } from 'react';
import type { Channel } from '../types';
import { useFavoritesStore } from '../stores/favoritesStore';
import ChannelLogo from './ChannelLogo';

interface ChannelCardProps {
  channel: Channel;
  onSelect: (channel: Channel) => void;
}

function ChannelCardInner({ channel, onSelect }: ChannelCardProps) {
  const isFavorite = useFavoritesStore((s) => s.favoriteIds.has(channel.id));
  const handleClick = useCallback(() => onSelect(channel), [onSelect, channel]);

  return (
    <div
      className="channel-card"
      data-focusable
      tabIndex={-1}
      onClick={handleClick}
    >
      <div className="channel-card__logo-container">
        <ChannelLogo src={channel.logo} name={channel.name} />
      </div>
      <div className="channel-card__info">
        <span className="channel-card__name">{channel.name}</span>
        <span className="channel-card__group">{channel.group}</span>
      </div>
      {isFavorite && <span className="channel-card__star">{'\u2605'}</span>}
    </div>
  );
}

const ChannelCard = memo(ChannelCardInner);
export default ChannelCard;
