import { useState, useCallback, useRef, useEffect } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import type { PlayerState } from '../types';
import type { SubtitleTrack } from '../services/avplay';
import { TizenPlayer, HTML5Player } from '../services/avplay';

export function usePlayer(): {
  play: () => void;
  stop: () => void;
  retry: () => void;
  playerState: PlayerState;
  subtitleTracks: SubtitleTrack[];
  currentSubtitleIndex: number;
  subtitleText: string;
  cycleSubtitles: () => void;
} {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const store = usePlayerStore();
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [currentSubtitleIndex, setCurrentSubtitleIndex] = useState(-1);
  const [subtitleText, setSubtitleText] = useState('');
  const playerRef = useRef<TizenPlayer | HTML5Player | null>(null);

  const play = useCallback(() => {
    const channel = usePlayerStore.getState().currentChannel;
    if (!channel) return;

    const setStatus = usePlayerStore.getState().setStatus;
    const setError = usePlayerStore.getState().setError;

    setStatus('loading');

    // Try AVPlay first (Samsung Tizen), fallback to HTML5 video
    if (typeof webapis !== 'undefined' && webapis.avplay) {
      try {
        const avplay = webapis.avplay;
        avplay.close();
        avplay.open(channel.url);
        avplay.setDisplayRect(0, 0, 1920, 1080);

        const tizenPlayer = new TizenPlayer();
        tizenPlayer.onSubtitleText = (text: string) => {
          setSubtitleText(text);
        };
        playerRef.current = tizenPlayer;

        avplay.setListener({
          onbufferingstart: () => setStatus('loading'),
          onbufferingcomplete: () => setStatus('playing'),
          oncurrentplaytime: () => {},
          onevent: () => {},
          onerror: () => setError('Playback error'),
          onsubtitlechange: (_duration: number, text: string) => {
            tizenPlayer.onSubtitleText?.(text);
          },
          onstreamcompleted: () => setStatus('idle'),
          ondrmevent: () => {},
        });
        avplay.prepareAsync(
          () => {
            avplay.play();
            setStatus('playing');
            setSubtitleTracks(tizenPlayer.getSubtitleTracks());
          },
          () => setError('Failed to prepare stream')
        );
      } catch {
        setError('AVPlay initialization failed');
      }
    } else {
      // HTML5 video fallback
      const video = document.getElementById('av-player') as HTMLVideoElement | null;
      if (video) {
        videoRef.current = video;

        const html5Player = new HTML5Player();
        html5Player.onSubtitleText = (text: string) => {
          setSubtitleText(text);
        };
        playerRef.current = html5Player;

        video.src = channel.url;
        video.onloadeddata = () => {
          setStatus('playing');
          setSubtitleTracks(html5Player.getSubtitleTracks());
        };
        video.onwaiting = () => setStatus('loading');
        video.onplaying = () => setStatus('playing');
        video.onerror = () => setError('Failed to play stream');
        video.play().catch(() => setError('Playback blocked'));

        // Listen for text tracks being added
        video.textTracks.addEventListener('addtrack', () => {
          setSubtitleTracks(html5Player.getSubtitleTracks());
        });
      }
    }
  }, []);

  const stop = useCallback(() => {
    const setStatus = usePlayerStore.getState().setStatus;

    if (typeof webapis !== 'undefined' && webapis.avplay) {
      try {
        webapis.avplay.stop();
        webapis.avplay.close();
      } catch {
        // Ignore cleanup errors
      }
    } else if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }

    playerRef.current = null;
    setSubtitleTracks([]);
    setCurrentSubtitleIndex(-1);
    setSubtitleText('');
    setStatus('idle');
  }, []);

  const retry = useCallback(() => {
    const clearError = usePlayerStore.getState().clearError;
    clearError();
    play();
  }, [play]);

  const cycleSubtitles = useCallback(() => {
    if (subtitleTracks.length === 0) return;

    const nextIndex =
      currentSubtitleIndex === -1
        ? 0
        : currentSubtitleIndex + 1 >= subtitleTracks.length
          ? -1
          : currentSubtitleIndex + 1;

    setCurrentSubtitleIndex(nextIndex);
    playerRef.current?.setSubtitleTrack(nextIndex);
  }, [subtitleTracks, currentSubtitleIndex]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    play,
    stop,
    retry,
    playerState: {
      status: store.status,
      currentChannel: store.currentChannel,
      errorMessage: store.errorMessage,
    },
    subtitleTracks,
    currentSubtitleIndex,
    subtitleText,
    cycleSubtitles,
  };
}
