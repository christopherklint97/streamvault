import { memo, useCallback, useRef, useEffect } from 'react';
import type { Channel } from '../types';
import { useFavoritesStore } from '../stores/favoritesStore';
import { acquireImage, releaseImage } from '../utils/image-pool';
import { isMobile } from '../utils/platform';
import { cn } from '../utils/cn';

const MOBILE = isMobile();

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
  const toggleFavorite = useFavoritesStore((s) => s.toggleFavorite);
  const handleClick = useCallback(() => onSelect(channel), [onSelect, channel]);
  const handleFavClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFavorite(channel.id);
  }, [toggleFavorite, channel.id]);
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
      className="relative flex flex-col bg-surface rounded-lg overflow-hidden border-2 border-transparent cursor-pointer [contain:layout_style_paint] transition-all duration-180 tap-none active:scale-[0.97] lg:active:scale-100 focus:border-accent focus:outline-hidden focus:scale-105 focus:z-[2] focus:will-change-transform lg:focus:scale-105"
      data-focusable
      data-vindex={vindex}
      tabIndex={-1}
      onClick={handleClick}
    >
      <div
        ref={logoRef}
        className="card-poster w-full h-[140px] lg:h-[200px] flex items-center justify-center bg-dark-deep relative [contain:layout_style]"
        style={!channel.logo ? { backgroundColor: getColorForName(channel.name) } : undefined}
        data-letter={channel.name.charAt(0).toUpperCase()}
      />
      <span className="py-1.5 px-2 lg:py-2.5 lg:px-3 text-11 lg:text-15 font-semibold whitespace-nowrap overflow-hidden text-ellipsis">{channel.name}</span>
      {MOBILE ? (
        <button
          className={cn(
            'absolute top-1 right-1 z-[3] w-7 h-7 rounded-full bg-black/50 border-none text-sm text-[#888] flex items-center justify-center tap-none',
            isFavorite && 'text-favorite'
          )}
          onClick={handleFavClick}
        >
          {isFavorite ? '\u2605' : '\u2606'}
        </button>
      ) : (
        isFavorite && <span className="absolute top-1.5 right-2 text-sm text-favorite z-[2]">{'\u2605'}</span>
      )}
    </div>
  );
}

const ChannelCard = memo(ChannelCardInner);
export default ChannelCard;
