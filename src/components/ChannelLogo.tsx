import { memo, useCallback } from 'react';

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
  const handleError = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    // Hide broken image, show fallback behind it
    (e.target as HTMLImageElement).style.display = 'none';
  }, []);

  if (!src) {
    return (
      <div
        className="channel-logo__fallback"
        style={{ backgroundColor: getColorForName(name) }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
    );
  }

  return (
    <div className="channel-logo" style={{ position: 'relative' }}>
      <div
        className="channel-logo__fallback"
        style={{ backgroundColor: getColorForName(name), position: 'absolute' }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
      <img
        className="channel-logo__img"
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={handleError}
        style={{ position: 'relative', maxWidth: '80%', maxHeight: '80%', objectFit: 'contain' }}
      />
    </div>
  );
}

const ChannelLogo = memo(ChannelLogoInner);
export default ChannelLogo;
