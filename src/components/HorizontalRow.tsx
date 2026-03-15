import { useRef, useEffect, useState, useCallback } from 'react';
import type { Channel } from '../types';
import { prefetchImages } from '../utils/image-pool';
import ChannelCard from './ChannelCard';

interface HorizontalRowProps {
  title: string;
  channels: Channel[];
  onSelect: (channel: Channel) => void;
}

const CARD_WIDTH = 216; // 200px card + 16px gap
const VISIBLE_COUNT = 8; // ~1852px viewport / 216px
const BUFFER = 2;

export default function HorizontalRow({ title, channels, onSelect }: HorizontalRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollIndex, setScrollIndex] = useState(0);

  // Compute visible window
  const startIdx = Math.max(0, scrollIndex - BUFFER);
  const endIdx = Math.min(channels.length - 1, scrollIndex + VISIBLE_COUNT + BUFFER);

  // Prefetch images for cards about to scroll into view
  useEffect(() => {
    const prefetchStart = endIdx + 1;
    const prefetchEnd = Math.min(channels.length - 1, endIdx + VISIBLE_COUNT);
    if (prefetchStart > prefetchEnd) return;

    const urls: string[] = [];
    for (let i = prefetchStart; i <= prefetchEnd; i++) {
      if (channels[i].logo) urls.push(channels[i].logo);
    }
    if (urls.length > 0) prefetchImages(urls);
  }, [endIdx, channels]);

  // Track focus to update scroll position and visible window
  const handleFocusIn = useCallback((e: FocusEvent) => {
    const target = e.target as HTMLElement;
    if (!target.hasAttribute('data-focusable') || !scrollRef.current) return;

    const el = scrollRef.current;
    const targetLeft = target.offsetLeft;
    const targetWidth = target.offsetWidth;
    const containerWidth = el.clientWidth;
    el.scrollLeft = Math.max(0, targetLeft - (containerWidth - targetWidth) / 2);

    // Update visible window based on new scroll position
    const newIndex = Math.floor(el.scrollLeft / CARD_WIDTH);
    setScrollIndex(newIndex);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('focusin', handleFocusIn as EventListener);
    return () => el.removeEventListener('focusin', handleFocusIn as EventListener);
  }, [handleFocusIn]);

  if (channels.length === 0) return null;

  // For small lists, render all (no virtualization overhead needed)
  const useVirtualization = channels.length > VISIBLE_COUNT + BUFFER * 2;

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-22 font-bold">{title}</h2>
      <div className="flex gap-2.5 lg:gap-4 overflow-x-auto py-2 px-1 [contain:content] [will-change:scroll-position] [-webkit-overflow-scrolling:touch]" ref={scrollRef}>
        {useVirtualization ? (
          <>
            {/* Spacer for items before visible window */}
            {startIdx > 0 && (
              <div style={{ width: startIdx * CARD_WIDTH, flexShrink: 0 }} />
            )}
            {channels.slice(startIdx, endIdx + 1).map((channel) => (
              <div key={channel.id} className="w-[130px] lg:w-[200px] shrink-0">
                <ChannelCard
                  channel={channel}
                  onSelect={onSelect}
                />
              </div>
            ))}
            {/* Spacer for items after visible window */}
            {endIdx < channels.length - 1 && (
              <div style={{ width: (channels.length - 1 - endIdx) * CARD_WIDTH, flexShrink: 0 }} />
            )}
          </>
        ) : (
          channels.map((channel) => (
            <div key={channel.id} className="w-[130px] lg:w-[200px] shrink-0">
              <ChannelCard
                channel={channel}
                onSelect={onSelect}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
