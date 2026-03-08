import { useRef, useEffect } from 'react';
import type { Channel } from '../types';
import ChannelCard from './ChannelCard';

interface HorizontalRowProps {
  title: string;
  channels: Channel[];
  onSelect: (channel: Channel) => void;
}

export default function HorizontalRow({ title, channels, onSelect }: HorizontalRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep focused card scrolled into view using manual scrollLeft (cheaper than scrollIntoView)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target.hasAttribute('data-focusable')) {
        const targetLeft = target.offsetLeft;
        const targetWidth = target.offsetWidth;
        const containerWidth = el.clientWidth;
        el.scrollLeft = Math.max(0, targetLeft - (containerWidth - targetWidth) / 2);
      }
    };

    el.addEventListener('focusin', handleFocusIn);
    return () => el.removeEventListener('focusin', handleFocusIn);
  }, []);

  if (channels.length === 0) return null;

  return (
    <div className="horizontal-row">
      <h2 className="horizontal-row__title">{title}</h2>
      <div className="horizontal-row__scroll" ref={scrollRef}>
        {channels.map((channel) => (
          <ChannelCard
            key={channel.id}
            channel={channel}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}
