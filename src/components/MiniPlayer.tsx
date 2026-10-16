import { useCallback, useSyncExternalStore } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { stopActivePlayback, togglePlayback } from '../hooks/usePlayer';
import { isTizen } from '../utils/platform';

const getVideo = () => document.getElementById('av-player') as HTMLVideoElement | null;

function subscribePaused(onChange: () => void): () => void {
  const video = getVideo();
  if (!video) return () => {};
  video.addEventListener('play', onChange);
  video.addEventListener('pause', onChange);
  return () => {
    video.removeEventListener('play', onChange);
    video.removeEventListener('pause', onChange);
  };
}

const getPaused = () => getVideo()?.paused ?? true;

/**
 * Now-playing bar shown outside the player view while background playback
 * (mobile PWA, audio-only) continues on the persistent <video>. Tizen uses
 * the remote and AVPlay stops when the player closes, so it is never shown.
 */
export default function MiniPlayer() {
  const currentView = useAppStore((s) => s.currentView);
  const currentChannel = usePlayerStore((s) => s.currentChannel);
  const status = usePlayerStore((s) => s.status);
  const audioOnly = usePlayerStore((s) => s.audioOnly);
  const paused = useSyncExternalStore(subscribePaused, getPaused, () => true);

  const openPlayer = useCallback(() => {
    useAppStore.getState().navigate('player');
  }, []);

  if (isTizen() || currentView === 'player' || !currentChannel || status === 'idle') return null;

  const subtitle = status === 'error' ? 'Playback error — tap to open'
    : status === 'loading' ? 'Loading…'
      : status === 'awaiting-gesture' ? 'Tap play to start'
        : audioOnly ? 'Audio only' : paused ? 'Paused' : 'Now playing';
  const showPause = status === 'playing' && !paused;

  return (
    <div
      data-mini-player
      role="region"
      aria-label="Now playing"
      className="fixed left-2 right-2 bottom-16 z-[201] flex items-center gap-2 rounded-xl border border-white/10 bg-[#161a22]/95 p-2 shadow-2xl backdrop-blur-md lg:left-[84px] lg:right-auto lg:bottom-4 lg:w-96"
    >
      <button
        type="button"
        className="flex flex-1 min-w-0 items-center gap-3 border-none bg-transparent p-0 text-left tap-none"
        onClick={openPlayer}
        aria-label={`Open player: ${currentChannel.name}`}
      >
        {currentChannel.logo ? (
          <img src={currentChannel.logo} alt="" className="h-10 w-10 shrink-0 rounded bg-black/40 object-contain" />
        ) : (
          <div aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-white/[0.06] text-xs text-[#777]">TV</div>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">{currentChannel.name}</span>
          <span className="block truncate text-12 text-[#999]">{subtitle}</span>
        </span>
      </button>
      {status !== 'error' && (
        <button
          type="button"
          data-mini-player-toggle
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-none bg-transparent text-white tap-none active:opacity-60"
          onClick={togglePlayback}
          aria-label={showPause ? 'Pause' : 'Play'}
        >
          {showPause ? (
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
          ) : (
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
      )}
      <button
        type="button"
        data-mini-player-stop
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-none bg-transparent text-white tap-none active:opacity-60"
        onClick={stopActivePlayback}
        aria-label="Stop playback"
      >
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>
  );
}
