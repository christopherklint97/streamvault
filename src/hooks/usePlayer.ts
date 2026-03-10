import { useState, useCallback, useRef, useEffect } from 'react';
import type HlsType from 'hls.js';
import { usePlayerStore } from '../stores/playerStore';
import { useChannelStore } from '../stores/channelStore';
import type { PlayerState } from '../types';
import type { SubtitleTrack } from '../services/avplay';
import { TizenPlayer, HTML5Player } from '../services/avplay';
import { saveWatchProgress, getWatchProgress } from '../services/channel-service';

const PROGRESS_SAVE_INTERVAL = 10_000; // Save progress every 10 seconds

/** Build a proxied stream URL that goes through our server */
function getStreamUrl(channelId: string): string {
  const apiBaseUrl = useChannelStore.getState().apiBaseUrl;
  return `${apiBaseUrl}/api/stream/${encodeURIComponent(channelId)}`;
}

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
  const hlsRef = useRef<HlsType | null>(null);
  const store = usePlayerStore();
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [currentSubtitleIndex, setCurrentSubtitleIndex] = useState(-1);
  const [subtitleText, setSubtitleText] = useState('');
  const playerRef = useRef<TizenPlayer | HTML5Player | null>(null);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const saveCurrentProgress = useCallback(() => {
    const channel = usePlayerStore.getState().currentChannel;
    if (!channel) return;

    // Don't track progress for live TV
    if (channel.contentType === 'livetv') return;

    if (typeof webapis !== 'undefined' && webapis.avplay) {
      try {
        const position = webapis.avplay.getCurrentTime() / 1000;
        const duration = webapis.avplay.getDuration() / 1000;
        if (duration > 0) {
          saveWatchProgress(channel.id, position, duration, channel.contentType);
        }
      } catch {
        // Player may not be in a valid state
      }
    } else if (videoRef.current) {
      const video = videoRef.current;
      const position = video.currentTime;
      const duration = video.duration;
      if (duration > 0 && isFinite(duration)) {
        saveWatchProgress(channel.id, position, duration, channel.contentType);
      }
    }
  }, []);

  const startProgressTracking = useCallback(() => {
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    progressIntervalRef.current = setInterval(saveCurrentProgress, PROGRESS_SAVE_INTERVAL);
  }, [saveCurrentProgress]);

  const stopProgressTracking = useCallback(() => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    // Final save on stop
    saveCurrentProgress();
  }, [saveCurrentProgress]);

  const play = useCallback(() => {
    const channel = usePlayerStore.getState().currentChannel;
    if (!channel) return;

    const setStatus = usePlayerStore.getState().setStatus;
    const setError = usePlayerStore.getState().setError;

    // Check for saved progress to resume from
    const savedProgress = channel.contentType !== 'livetv'
      ? getWatchProgress(channel.id)
      : null;
    const resumePosition = savedProgress ? savedProgress.position : 0;

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
          onstreamcompleted: () => {
            saveCurrentProgress();
            setStatus('idle');
          },
          ondrmevent: () => {},
        });
        avplay.prepareAsync(
          () => {
            if (resumePosition > 0) {
              avplay.seekTo(resumePosition * 1000);
            }
            avplay.play();
            setStatus('playing');
            setSubtitleTracks(tizenPlayer.getSubtitleTracks());
            startProgressTracking();
          },
          () => setError('Failed to prepare stream')
        );
      } catch {
        setError('AVPlay initialization failed');
      }
    } else {
      // HTML5 video fallback (with HLS.js for stream support)
      const video = document.getElementById('av-player') as HTMLVideoElement | null;
      if (video) {
        videoRef.current = video;

        const html5Player = new HTML5Player();
        html5Player.onSubtitleText = (text: string) => {
          setSubtitleText(text);
        };
        playerRef.current = html5Player;

        // Clean up any previous HLS instance
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }

        const setupEvents = () => {
          video.onloadeddata = () => {
            if (resumePosition > 0) {
              video.currentTime = resumePosition;
            }
            setStatus('playing');
            setSubtitleTracks(html5Player.getSubtitleTracks());
            startProgressTracking();
          };
          video.onwaiting = () => setStatus('loading');
          video.onplaying = () => setStatus('playing');
          video.onerror = () => setError('Failed to play stream');
          video.onended = () => {
            saveCurrentProgress();
            setStatus('idle');
          };
          video.textTracks.addEventListener('addtrack', () => {
            setSubtitleTracks(html5Player.getSubtitleTracks());
          });
        };

        // Use the server proxy for stream playback (handles CORS + HLS conversion)
        const playUrl = getStreamUrl(channel.id);
        // Live TV streams are served as HLS (.m3u8) through the proxy
        const isHls = channel.contentType === 'livetv';

        if (isHls && video.canPlayType('application/vnd.apple.mpegurl')) {
          // Safari native HLS
          video.src = playUrl;
          setupEvents();
          video.play().catch(() => setError('Playback blocked'));
        } else if (isHls) {
          // Use HLS.js (dynamically loaded) for Chrome/Firefox/etc
          setupEvents();
          import('hls.js').then(({ default: Hls }) => {
            if (!Hls.isSupported()) {
              setError('HLS playback not supported on this browser');
              return;
            }
            const hls = new Hls({
              enableWorker: true,
              lowLatencyMode: true,
              maxBufferLength: 10,
              maxMaxBufferLength: 30,
            });
            hlsRef.current = hls;
            hls.loadSource(playUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              video.play().catch(() => setError('Playback blocked'));
            });
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal) {
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                  hls.startLoad();
                } else {
                  setError('Stream playback failed');
                }
              }
            });
          }).catch(() => setError('Failed to load HLS player'));
        } else {
          // Direct playback (MP4, etc)
          video.src = playUrl;
          setupEvents();
          video.play().catch(() => setError('Playback blocked'));
        }
      }
    }
  }, [saveCurrentProgress, startProgressTracking]);

  const stop = useCallback(() => {
    const setStatus = usePlayerStore.getState().setStatus;

    stopProgressTracking();

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

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
  }, [stopProgressTracking]);

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
