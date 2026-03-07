import { memo, useEffect, useRef, useState } from 'react';

interface ChannelLogoProps {
  src: string;
  name: string;
  size?: number;
  className?: string;
}

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

const pendingLoads: Array<() => void> = [];
let activeLoads = 0;
const MAX_CONCURRENT = 6;

function processQueue() {
  while (activeLoads < MAX_CONCURRENT && pendingLoads.length > 0) {
    const next = pendingLoads.shift();
    if (next) {
      activeLoads++;
      next();
    }
  }
}

function releaseSlot() {
  activeLoads--;
  processQueue();
}

type LoadState = 'loading' | 'loaded' | 'error';

function ChannelLogoInner({ src, name, size = 80, className }: ChannelLogoProps) {
  const [prevSrc, setPrevSrc] = useState(src);
  const [state, setState] = useState<LoadState>(src ? 'loading' : 'error');
  const cancelledRef = useRef(false);
  const enqueuedRef = useRef(false);

  // Reset state synchronously when src changes (outside effect, no ref access)
  if (prevSrc !== src) {
    setPrevSrc(src);
    setState(src ? 'loading' : 'error');
  }

  useEffect(() => {
    cancelledRef.current = false;
    enqueuedRef.current = false;

    if (!src) {
      return;
    }

    const loadFn = () => {
      if (cancelledRef.current) {
        releaseSlot();
        return;
      }
      const img = new Image();
      img.onload = () => {
        releaseSlot();
        if (!cancelledRef.current) {
          setState('loaded');
        }
      };
      img.onerror = () => {
        releaseSlot();
        if (!cancelledRef.current) {
          setState('error');
        }
      };
      img.src = src;
    };

    enqueuedRef.current = true;
    pendingLoads.push(loadFn);
    processQueue();

    return () => {
      cancelledRef.current = true;
      if (enqueuedRef.current) {
        const idx = pendingLoads.indexOf(loadFn);
        if (idx !== -1) {
          pendingLoads.splice(idx, 1);
        }
      }
    };
  }, [src]);

  const fallback = (
    <div
      className="channel-logo__fallback"
      style={{
        backgroundColor: getColorForName(name),
        fontSize: size * 0.45,
        borderRadius: size * 0.1,
      }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );

  return (
    <div
      className={`channel-logo${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, borderRadius: size * 0.1 }}
    >
      {state === 'loaded' ? (
        <img
          className="channel-logo__img"
          src={src}
          alt={name}
          decoding="async"
          loading="lazy"
        />
      ) : (
        fallback
      )}
    </div>
  );
}

const ChannelLogo = memo(ChannelLogoInner);
export default ChannelLogo;
