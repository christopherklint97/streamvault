import { useState, useCallback, useRef, useEffect } from 'react';
import type HlsType from 'hls.js';
import { usePlayerStore } from '../stores/playerStore';
import { useChannelStore } from '../stores/channelStore';
import type { PlayerState } from '../types';
import type { SubtitleTrack } from '../services/avplay';
import { TizenPlayer, HTML5Player } from '../services/avplay';
import { saveWatchProgress, getWatchProgress } from '../services/channel-service';
import { clientLogger as log } from '../utils/logger';

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
    if (!channel) {
      log.warn('play() called but no currentChannel set');
      return;
    }

    const setStatus = usePlayerStore.getState().setStatus;
    const setError = usePlayerStore.getState().setError;

    log.info(`▶ play() channel="${channel.name}" id=${channel.id} type=${channel.contentType} url=${channel.url ? channel.url.substring(0, 60) + '...' : '(empty)'}`);

    // Check for saved progress to resume from
    const savedProgress = channel.contentType !== 'livetv'
      ? getWatchProgress(channel.id)
      : null;
    const resumePosition = savedProgress ? savedProgress.position : 0;
    if (resumePosition > 0) {
      log.info(`Resuming from position ${resumePosition.toFixed(1)}s`);
    }

    setStatus('loading');

    // Try AVPlay first (Samsung Tizen), fallback to HTML5 video
    if (typeof webapis !== 'undefined' && webapis.avplay) {
      log.info('Using Tizen AVPlay backend');
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
          onbufferingstart: () => { log.debug('AVPlay: buffering start'); setStatus('loading'); },
          onbufferingcomplete: () => { log.debug('AVPlay: buffering complete'); setStatus('playing'); },
          oncurrentplaytime: () => {},
          onevent: () => {},
          onerror: () => { log.error('AVPlay: playback error'); setError('Playback error'); },
          onsubtitlechange: (_duration: number, text: string) => {
            tizenPlayer.onSubtitleText?.(text);
          },
          onstreamcompleted: () => {
            log.info('AVPlay: stream completed');
            saveCurrentProgress();
            setStatus('idle');
          },
          ondrmevent: () => {},
        });
        avplay.prepareAsync(
          () => {
            log.info('AVPlay: prepared, starting playback');
            if (resumePosition > 0) {
              avplay.seekTo(resumePosition * 1000);
            }
            avplay.play();
            setStatus('playing');
            setSubtitleTracks(tizenPlayer.getSubtitleTracks());
            startProgressTracking();
          },
          () => { log.error('AVPlay: prepare failed'); setError('Failed to prepare stream'); }
        );
      } catch (e) {
        log.error('AVPlay: init failed', e);
        setError('AVPlay initialization failed');
      }
    } else {
      // HTML5 video fallback (with HLS.js for stream support)
      log.info('Using HTML5 video backend');
      const video = document.getElementById('av-player') as HTMLVideoElement | null;

      if (!video) {
        log.error('HTML5: <video id="av-player"> element NOT found in DOM');
        setError('Video element not found');
        return;
      }

      log.info(`HTML5: found video element, readyState=${video.readyState}, networkState=${video.networkState}`);
      videoRef.current = video;

      const html5Player = new HTML5Player();
      html5Player.onSubtitleText = (text: string) => {
        setSubtitleText(text);
      };
      playerRef.current = html5Player;

      // Clean up any previous HLS instance
      if (hlsRef.current) {
        log.info('HTML5: destroying previous HLS instance');
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      const setupEvents = () => {
        video.onloadstart = () => log.debug('HTML5 event: loadstart');
        video.onloadedmetadata = () => log.info(`HTML5 event: loadedmetadata, duration=${video.duration}, videoWidth=${video.videoWidth}x${video.videoHeight}`);
        video.onloadeddata = () => {
          log.info(`HTML5 event: loadeddata, readyState=${video.readyState}`);
          if (resumePosition > 0) {
            video.currentTime = resumePosition;
          }
          setStatus('playing');
          setSubtitleTracks(html5Player.getSubtitleTracks());
          startProgressTracking();
        };
        video.oncanplay = () => log.info('HTML5 event: canplay');
        video.onwaiting = () => { log.debug('HTML5 event: waiting'); setStatus('loading'); };
        video.onplaying = () => { log.info('HTML5 event: playing'); setStatus('playing'); };
        video.onstalled = () => log.warn('HTML5 event: stalled');
        video.onsuspend = () => log.debug('HTML5 event: suspend');
        video.onerror = () => {
          const err = video.error;
          const errMsg = err ? `code=${err.code} message="${err.message}"` : 'unknown';
          log.error(`HTML5 event: error — ${errMsg}`);
          setError(`Playback failed: ${errMsg}`);
        };
        video.onabort = () => log.warn('HTML5 event: abort');
        video.onended = () => {
          log.info('HTML5 event: ended');
          saveCurrentProgress();
          setStatus('idle');
        };
        video.textTracks.addEventListener('addtrack', () => {
          setSubtitleTracks(html5Player.getSubtitleTracks());
        });
      };

      // Use the server proxy for stream playback (handles CORS + HLS conversion)
      const playUrl = getStreamUrl(channel.id);
      log.info(`HTML5: playUrl=${playUrl}`);

      // Live TV streams are served as HLS (.m3u8) through the proxy
      const isHls = channel.contentType === 'livetv';
      log.info(`HTML5: isHls=${isHls}, contentType=${channel.contentType}`);

      if (isHls && video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari native HLS
        log.info('HTML5: using Safari native HLS');
        video.src = playUrl;
        setupEvents();
        video.play().catch((e) => { log.error('HTML5: play() rejected (Safari HLS)', e); setError('Playback blocked'); });
      } else if (isHls) {
        // Use HLS.js (dynamically loaded) for Chrome/Firefox/etc
        log.info('HTML5: loading HLS.js dynamically...');
        setupEvents();
        import('hls.js').then(({ default: Hls }) => {
          log.info(`HTML5: HLS.js loaded, isSupported=${Hls.isSupported()}`);
          if (!Hls.isSupported()) {
            log.error('HTML5: HLS.js not supported on this browser');
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
          log.info(`HTML5: HLS.js attached, loading source ${playUrl}`);

          hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
            log.info(`HTML5: HLS manifest parsed, levels=${data.levels.length}`);
            video.play().catch((e) => { log.error('HTML5: play() rejected (HLS.js)', e); setError('Playback blocked'); });
          });
          hls.on(Hls.Events.MANIFEST_LOADING, () => log.debug('HLS: manifest loading...'));
          hls.on(Hls.Events.MANIFEST_LOADED, () => log.info('HLS: manifest loaded'));
          hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => log.debug(`HLS: level loaded, duration=${data.details.totalduration?.toFixed(1)}s`));
          hls.on(Hls.Events.FRAG_LOADED, () => log.debug('HLS: fragment loaded'));
          hls.on(Hls.Events.ERROR, (_event, data) => {
            log.error(`HLS error: type=${data.type} details=${data.details} fatal=${data.fatal} url=${data.url || '?'}`);
            if (data.fatal) {
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                log.warn('HLS: fatal network error, attempting recovery...');
                hls.startLoad();
              } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                log.warn('HLS: fatal media error, attempting recovery...');
                hls.recoverMediaError();
              } else {
                log.error('HLS: unrecoverable fatal error');
                setError('Stream playback failed');
              }
            }
          });
        }).catch((e) => { log.error('HTML5: failed to import hls.js', e); setError('Failed to load HLS player'); });
      } else {
        // Direct playback (MP4, etc)
        log.info(`HTML5: direct video playback (non-HLS), setting src=${playUrl}`);
        video.src = playUrl;
        setupEvents();
        video.play().catch((e) => { log.error('HTML5: play() rejected (direct)', e); setError('Playback blocked'); });
      }
    }
  }, [saveCurrentProgress, startProgressTracking]);

  const stop = useCallback(() => {
    log.info('⏹ stop() called');
    const setStatus = usePlayerStore.getState().setStatus;

    stopProgressTracking();

    if (hlsRef.current) {
      log.info('Destroying HLS instance');
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
    log.info('🔄 retry() called');
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
