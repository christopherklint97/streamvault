import { memo, useCallback, useRef } from 'react';

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

interface ChannelLogoProps {
  src: string;
  name: string;
}

function ChannelLogoInner({ src, name }: ChannelLogoProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);

  const handleError = useCallback(() => {
    if (imgRef.current) imgRef.current.style.display = 'none';
    if (fallbackRef.current) fallbackRef.current.style.display = 'flex';
  }, []);

  if (!src) {
    return (
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center text-24 font-bold text-white"
        style={{ backgroundColor: getColorForName(name) }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
    );
  }

  return (
    <>
      <img
        ref={imgRef}
        className="max-w-[64px] max-h-[48px] object-contain"
        src={src}
        alt=""
        width={64}
        height={48}
        loading="lazy"
        decoding="async"
        onError={handleError}
      />
      <div
        ref={fallbackRef}
        className="w-10 h-10 rounded-full flex items-center justify-center text-24 font-bold text-white"
        style={{ display: 'none', backgroundColor: getColorForName(name) }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
    </>
  );
}

const ChannelLogo = memo(ChannelLogoInner);
export default ChannelLogo;
