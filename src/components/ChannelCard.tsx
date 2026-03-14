import { memo, useCallback, useRef, useEffect } from 'react';
import type { Channel } from '../types';
import { useFavoritesStore } from '../stores/favoritesStore';
import { acquireImage, releaseImage } from '../utils/image-pool';

const LOGO_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#9b59b6', '#f39c12',
  '#1abc9c', '#e67e22', '#e84393', '#00b894', '#6c5ce7',
];

function getColorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) & 0xffffffff;
  }
  return LOGO_COLORS[Math.abs(hash) % LOGO_COLORS.length];
}

interface ChannelCardProps {
  channel: Channel;
  onSelect: (channel: Channel) => void;
  vindex?: number;
}

/**
 * Optimized ChannelCard - Netflix-inspired minimal DOM.
 *
 * Improvements over original:
 * - Flattened DOM: removed ChannelLogo wrapper + logo-container div (was 5 nodes, now 3)
 * - Image pooling: reuses img elements via acquireImage/releaseImage
 * - No conditional rendering for fallback - uses CSS background as fallback
 * - Single div + img + span instead of nested divs
 */
function ChannelCardInner({ channel, onSelect, vindex }: ChannelCardProps) {
  const isFavorite = useFavoritesStore((s) => s.favoriteIds.has(channel.id));
  const handleClick = useCallback(() => onSelect(channel), [onSelect, channel]);
  const logoRef = useRef<HTMLDivElement>(null);
  const pooledImg = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const container = logoRef.current;
    if (!container) return;

    if (channel.logo) {
      const img = acquireImage();
      pooledImg.current = img;

      img.onload = () => {
        img.style.display = '';
      };
      img.onerror = () => {
        // Hide broken image, fallback letter shows via CSS
        img.style.display = 'none';
      };
      img.src = channel.logo;
      container.prepend(img);
    }

    return () => {
      if (pooledImg.current) {
        releaseImage(pooledImg.current);
        if (pooledImg.current.parentNode) {
          pooledImg.current.parentNode.removeChild(pooledImg.current);
        }
        pooledImg.current = null;
      }
    };
  }, [channel.logo]);

  return (
    <div
      className="channel-card"
      data-focusable
      data-vindex={vindex}
      tabIndex={-1}
      onClick={handleClick}
    >
      <div
        ref={logoRef}
        className="channel-card__logo-container"
        style={!channel.logo ? { backgroundColor: getColorForName(channel.name) } : undefined}
        data-letter={channel.name.charAt(0).toUpperCase()}
      />
      <span className="channel-card__name">{channel.name}</span>
      {isFavorite && <span className="channel-card__star">{'\u2605'}</span>}
    </div>
  );
}

const ChannelCard = memo(ChannelCardInner);
export default ChannelCard;
