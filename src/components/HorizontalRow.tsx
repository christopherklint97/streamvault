import { useRef, useState, useCallback, useEffect } from 'react';
import type { Channel } from '../types';
import { KEY_CODES } from '../utils/keys';
import ChannelCard from './ChannelCard';

interface HorizontalRowProps {
  title: string;
  channels: Channel[];
  onSelect: (channel: Channel) => void;
}

export default function HorizontalRow({ title, channels, onSelect }: HorizontalRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);

  const updateArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowLeftArrow(el.scrollLeft > 10);
    setShowRightArrow(el.scrollLeft + el.clientWidth < el.scrollWidth - 10);
  }, []);

  useEffect(() => {
    updateArrows();
    const el = scrollRef.current;
    if (el) {
      el.addEventListener('scroll', updateArrows);
      return () => el.removeEventListener('scroll', updateArrows);
    }
  }, [updateArrows, channels]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let next = focusIndex;

      switch (e.keyCode) {
        case KEY_CODES.LEFT:
          if (focusIndex > 0) {
            next = focusIndex - 1;
            e.preventDefault();
            e.stopPropagation();
          }
          break;
        case KEY_CODES.RIGHT:
          if (focusIndex < channels.length - 1) {
            next = focusIndex + 1;
            e.preventDefault();
            e.stopPropagation();
          }
          break;
        case KEY_CODES.ENTER:
          e.preventDefault();
          if (channels[focusIndex]) {
            onSelect(channels[focusIndex]);
          }
          return;
        default:
          return;
      }

      if (next !== focusIndex) {
        setFocusIndex(next);
        const container = scrollRef.current;
        if (container) {
          const cards = container.querySelectorAll('[data-focusable]');
          const card = cards[next] as HTMLElement;
          card?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
        }
      }
    },
    [focusIndex, channels, onSelect]
  );

  if (channels.length === 0) return null;

  return (
    <div className="horizontal-row" onKeyDown={handleKeyDown}>
      <h2 className="horizontal-row__title">{title}</h2>
      <div className="horizontal-row__container">
        {showLeftArrow && <div className="horizontal-row__arrow horizontal-row__arrow--left">{'\u25C0'}</div>}
        <div className="horizontal-row__scroll" ref={scrollRef}>
          {channels.map((channel, idx) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              isFocused={idx === focusIndex}
              onSelect={() => onSelect(channel)}
            />
          ))}
        </div>
        {showRightArrow && <div className="horizontal-row__arrow horizontal-row__arrow--right">{'\u25B6'}</div>}
      </div>
    </div>
  );
}
