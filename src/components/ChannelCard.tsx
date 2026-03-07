import { memo } from 'react';
import type { Channel } from '../types';
import { KEY_CODES } from '../utils/keys';
import ChannelLogo from './ChannelLogo';

interface ChannelCardProps {
  channel: Channel;
  isFocused: boolean;
  onSelect: () => void;
}

function ChannelCardInner({ channel, isFocused, onSelect }: ChannelCardProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.keyCode === KEY_CODES.ENTER) {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <div
      className={`channel-card${isFocused ? ' channel-card--focused' : ''}`}
      data-focusable
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={onSelect}
    >
      <div className="channel-card__logo-container">
        <ChannelLogo src={channel.logo} name={channel.name} />
      </div>
      <div className="channel-card__info">
        <span className="channel-card__name">{channel.name}</span>
        <span className="channel-card__group">{channel.group}</span>
      </div>
      {channel.isFavorite && <span className="channel-card__star">{'\u2605'}</span>}
    </div>
  );
}

const ChannelCard = memo(ChannelCardInner);
export default ChannelCard;
