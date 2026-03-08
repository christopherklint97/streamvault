import { useRef, useState, useCallback, useEffect } from 'react';
import type { Channel } from '../types';
import ChannelCard from './ChannelCard';

interface HorizontalRowProps {
  title: string;
  channels: Channel[];
  onSelect: (channel: Channel) => void;
}

export default function HorizontalRow({ title, channels, onSelect }: HorizontalRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
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

  // Keep focused card scrolled into view via focus event listener
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target.hasAttribute('data-focusable')) {
        target.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      }
    };

    el.addEventListener('focusin', handleFocusIn);
    return () => el.removeEventListener('focusin', handleFocusIn);
  }, []);

  if (channels.length === 0) return null;

  return (
    <div className="horizontal-row">
      <h2 className="horizontal-row__title">{title}</h2>
      <div className="horizontal-row__container">
        {showLeftArrow && <div className="horizontal-row__arrow horizontal-row__arrow--left">{'\u25C0'}</div>}
        <div className="horizontal-row__scroll" ref={scrollRef}>
          {channels.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              isFocused={false}
              onSelect={() => onSelect(channel)}
            />
          ))}
        </div>
        {showRightArrow && <div className="horizontal-row__arrow horizontal-row__arrow--right">{'\u25B6'}</div>}
      </div>
    </div>
  );
}
