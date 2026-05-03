import { useState, useCallback, useRef, useEffect } from 'react';
import type MpegtsType from 'mpegts.js';
import { usePlayerStore } from '../stores/playerStore';
import { useChannelStore } from '../stores/channelStore';
import type { PlayerState } from '../types';
import type { SubtitleTrack } from '../services/avplay';
import { TizenPlayer } from '../services/avplay';
import { saveWatchProgress, getWatchProgress } from '../services/channel-service';
import { clientLogger as log } from '../utils/logger';
import { useAppStore } from '../stores/appStore';

const toast = (msg: string) => useAppStore.getState().showToastMessage(msg);

const PROGRESS_SAVE_INTERVAL = 10_000; // Save progress every 10 seconds

// ---------------------------------------------------------------------------
// Module-level state — persists across Player mount/unmount so background
// playback keeps working even after the user navigates away.
// ---------------------------------------------------------------------------

let activeMpegtsPlayer: MpegtsType.Player | null = null;
let bgProgressInterval: ReturnType<typeof setInterval> | null = null;
let bgBufferTimer: ReturnType<typeof setTimeout> | null = null;

// Tizen AVPlay live-stream resilience: auto-retry on stalls and unexpected
// stream completions. Throttled so a permanently-broken stream stops looping.
let avplayStallTimer: ReturnType<typeof setTimeout> | null = null;
let avplayLastRetryAt = 0;
const AVPLAY_STALL_TIMEOUT_MS = 8000;
const AVPLAY_RETRY_COOLDOWN_MS = 2000;
function clearAvplayStallTimer() {
  if (avplayStallTimer) {
    clearTimeout(avplayStallTimer);
    avplayStallTimer = null;
  }
}

/** Save watch progress using the current video/avplay state */
function saveProgressNow() {
  const channel = usePlayerStore.getState().currentChannel;
  if (!channel || channel.contentType === 'livetv') return;

  if (typeof webapis !== 'undefined' && webapis.avplay) {
    try {
      const position = webapis.avplay.getCurrentTime() / 1000;
      const duration = webapis.avplay.getDuration() / 1000;
      if (duration > 0) saveWatchProgress(channel.id, position, duration, channel.contentType);
    } catch { /* ignore */ }
  } else {
    const video = document.getElementById('av-player') as HTMLVideoElement | null;
    if (video && video.duration > 0 && isFinite(video.duration)) {
      saveWatchProgress(channel.id, video.currentTime, video.duration, channel.contentType);
    }
  }
}

function startBgProgressTracking() {
  if (bgProgressInterval) clearInterval(bgProgressInterval);
  bgProgressInterval = setInterval(saveProgressNow, PROGRESS_SAVE_INTERVAL);
}

function stopBgProgressTracking() {
  if (bgProgressInterval) {
    clearInterval(bgProgressInterval);
    bgProgressInterval = null;
  }
  saveProgressNow();
}

/** Set up Media Session API so the user gets notification-center controls */
function setupMediaSession(channelName: string) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({ title: channelName });
  navigator.mediaSession.playbackState = 'playing';

  const getVideo = () => document.getElementById('av-player') as HTMLVideoElement | null;

  navigator.mediaSession.setActionHandler('play', () => {
    getVideo()?.play().catch(() => {});
    navigator.mediaSession.playbackState = 'playing';
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    getVideo()?.pause();
    navigator.mediaSession.playbackState = 'paused';
  });
  navigator.mediaSession.setActionHandler('stop', () => {
    stopPlayback();
  });
  navigator.mediaSession.setActionHandler('seekbackward', () => {
    const v = getVideo();
    if (v) v.currentTime = Math.max(0, v.currentTime - 10);
  });
  navigator.mediaSession.setActionHandler('seekforward', () => {
    const v = getVideo();
    if (v) v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 10);
  });
}

function clearMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = null;
  navigator.mediaSession.playbackState = 'none';
  for (const action of ['play', 'pause', 'stop', 'seekbackward', 'seekforward'] as MediaSessionAction[]) {
    try { navigator.mediaSession.setActionHandler(action, null); } catch { /* unsupported */ }
  }
}

/** Fully stop playback — called from hook stop() and Media Session stop handler */
function stopPlayback() {
  log.info('⏹ stopPlayback()');

  stopBgProgressTracking();

  if (bgBufferTimer) { clearTimeout(bgBufferTimer); bgBufferTimer = null; }

  if (activeMpegtsPlayer) {
    log.info('Destroying mpegts.js player');
    activeMpegtsPlayer.destroy();
    activeMpegtsPlayer = null;
  }

  if (typeof webapis !== 'undefined' && webapis.avplay) {
    clearAvplayStallTimer();
    try {
      webapis.avplay.stop();
      webapis.avplay.close();
    } catch (err) {
      toast(`Player cleanup error: ${err}`);
    }
  } else {
    const v = document.getElementById('av-player') as HTMLVideoElement | null;
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
  }

  clearMediaSession();
  usePlayerStore.getState().setStatus('idle');
}

// ---------------------------------------------------------------------------

/** Build a proxied stream URL that goes through our server */
export function getStreamUrl(channelId: string, directUrl?: string): string {
  const apiBaseUrl = useChannelStore.getState().apiBaseUrl;
  let url = `${apiBaseUrl}/api/stream/${encodeURIComponent(channelId)}`;
  // For episodes not in DB, pass URL and type as query params
  if (directUrl && channelId.startsWith('episode_')) {
    url += `?url=${encodeURIComponent(directUrl)}&type=series`;
  }
  return url;
}

export function usePlayer(): {
  play: () => void;
  stop: () => void;
  retry: () => void;
  togglePlay: () => void;
  seek: (time: number) => void;
  getVideoElement: () => HTMLVideoElement | null;
  playerState: PlayerState;
  subtitleTracks: SubtitleTrack[];
  currentSubtitleIndex: number;
  subtitleText: string;
  cycleSubtitles: () => void;
} {
  const store = usePlayerStore();
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [currentSubtitleIndex, setCurrentSubtitleIndex] = useState(-1);
  const [subtitleText, setSubtitleText] = useState('');
  const playerRef = useRef<TizenPlayer | null>(null);

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
      const isLive = channel.contentType === 'livetv';
      try {
        const avplay = webapis.avplay;
        clearAvplayStallTimer();
        avplay.close();
        avplay.open(channel.url);
        avplay.setDisplayRect(0, 0, 1920, 1080);

        // Bigger buffer for live MPEG-TS over HTTP — Tizen's defaults stall
        // frequently on flaky upstream feeds. Catch unsupported-call errors so
        // older firmware doesn't break.
        try {
          avplay.setBufferingParam?.(
            'PLAYER_BUFFER_FOR_PLAY',
            'PLAYER_BUFFER_SIZE_IN_SECOND',
            isLive ? 10 : 5
          );
          avplay.setBufferingParam?.(
            'PLAYER_BUFFER_FOR_RESUME',
            'PLAYER_BUFFER_SIZE_IN_SECOND',
            isLive ? 10 : 5
          );
        } catch (err) {
          log.warn('AVPlay: setBufferingParam unsupported', err);
        }

        const tizenPlayer = new TizenPlayer();
        tizenPlayer.onSubtitleText = (text: string) => {
          setSubtitleText(text);
        };
        playerRef.current = tizenPlayer;

        // Throttled retry — used by stall watchdog, onerror, and onstreamcompleted (live).
        const tryAutoRetry = (reason: string) => {
          const now = Date.now();
          if (now - avplayLastRetryAt < AVPLAY_RETRY_COOLDOWN_MS) {
            log.warn(`AVPlay: ${reason} — skipping retry (cooldown)`);
            return false;
          }
          avplayLastRetryAt = now;
          log.warn(`AVPlay: ${reason} — auto-retrying`);
          clearAvplayStallTimer();
          play();
          return true;
        };

        const armStallWatchdog = () => {
          clearAvplayStallTimer();
          avplayStallTimer = setTimeout(() => {
            avplayStallTimer = null;
            tryAutoRetry('stall watchdog fired');
          }, AVPLAY_STALL_TIMEOUT_MS);
        };

        avplay.setListener({
          onbufferingstart: () => {
            log.debug('AVPlay: buffering start');
            setStatus('loading');
            armStallWatchdog();
          },
          onbufferingcomplete: () => {
            log.debug('AVPlay: buffering complete');
            setStatus('playing');
            clearAvplayStallTimer();
          },
          oncurrentplaytime: () => {
            // Progress means the stream is alive — cancel any pending watchdog.
            clearAvplayStallTimer();
          },
          onevent: () => {},
          onerror: () => {
            log.error('AVPlay: playback error');
            if (isLive && tryAutoRetry('onerror')) return;
            setError('Playback error');
          },
          onsubtitlechange: (_duration: number, text: string) => {
            tizenPlayer.onSubtitleText?.(text);
          },
          onstreamcompleted: () => {
            log.info('AVPlay: stream completed');
            // Live streams "completing" usually means the upstream dropped us — retry.
            if (isLive && tryAutoRetry('live stream completed')) return;
            saveProgressNow();
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
            startBgProgressTracking();
            setupMediaSession(channel.name);
          },
          () => {
            log.error('AVPlay: prepare failed');
            if (isLive && tryAutoRetry('prepare failed')) return;
            setError('Failed to prepare stream');
          }
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

      // Clean up any previous playback state
      if (activeMpegtsPlayer) {
        log.info('HTML5: destroying previous mpegts.js instance');
        activeMpegtsPlayer.destroy();
        activeMpegtsPlayer = null;
      }
      // Reset the video element so the new source can attach cleanly
      video.pause();
      video.removeAttribute('src');
      video.load();

      // Enable auto-PiP for background playback (Safari-only, may not work in PWA standalone)
      try {
        if ('autoPictureInPicture' in video) {
          (video as HTMLVideoElement & { autoPictureInPicture: boolean }).autoPictureInPicture = true;
        }
      } catch { /* ignore */ }

      const setupEvents = () => {
        video.onloadstart = () => log.debug('HTML5 event: loadstart');
        video.onloadedmetadata = () => log.info(`HTML5 event: loadedmetadata, duration=${video.duration}, videoWidth=${video.videoWidth}x${video.videoHeight}`);
        video.onloadeddata = () => {
          log.info(`HTML5 event: loadeddata, readyState=${video.readyState}`);
          if (resumePosition > 0) {
            video.currentTime = resumePosition;
          }
          startBgProgressTracking();
        };
        video.oncanplay = () => {
          log.info('HTML5 event: canplay — attempting play()');
          video.play().then(() => {
            log.info('HTML5: play() succeeded');
            setStatus('playing');
          }).catch((e) => {
            log.error('HTML5: play() rejected on canplay', e);
            setError('Playback blocked — tap to retry');
          });
        };
        video.onwaiting = () => {
          log.debug('HTML5 event: waiting');
          // Delay showing loading spinner to avoid flashing during brief rebuffers
          if (bgBufferTimer) clearTimeout(bgBufferTimer);
          bgBufferTimer = setTimeout(() => setStatus('loading'), 1500);
        };
        video.onplaying = () => {
          log.info('HTML5 event: playing');
          if (bgBufferTimer) { clearTimeout(bgBufferTimer); bgBufferTimer = null; }
          setStatus('playing');
          setupMediaSession(channel.name);
        };
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
          saveProgressNow();
          setStatus('idle');
          clearMediaSession();
        };
        video.textTracks.addEventListener('addtrack', () => {
          const tracks: SubtitleTrack[] = [];
          for (let i = 0; i < video.textTracks.length; i++) {
            const t = video.textTracks[i];
            tracks.push({ index: i, language: t.language || 'unknown', label: t.label || `Track ${i + 1}` });
          }
          setSubtitleTracks(tracks);
        });
      };

      const isLiveTs = channel.contentType === 'livetv';
      const isRecording = channel.id.startsWith('recording_');
      // Recordings have a direct server URL; live/VOD go through stream proxy
      const playUrl = isRecording
        ? `${useChannelStore.getState().apiBaseUrl}${channel.url}`
        : getStreamUrl(channel.id, channel.url);
      log.info(`HTML5: playUrl=${playUrl}, contentType=${channel.contentType}`);

      if (isLiveTs) {
        // Live TV: MPEG-TS stream — use mpegts.js to demux in browser
        log.info('HTML5: loading mpegts.js for live MPEG-TS playback...');
        setupEvents();
        import('mpegts.js').then(({ default: mpegts }) => {
          log.info(`HTML5: mpegts.js loaded, isSupported=${mpegts.isSupported()}`);
          if (!mpegts.isSupported()) {
            log.error('HTML5: mpegts.js not supported');
            setError('Live TV playback not supported on this browser');
            return;
          }
          const player = mpegts.createPlayer({
            type: 'mpegts',
            isLive: true,
            url: playUrl,
          }, {
            enableWorker: false,
            enableStashBuffer: true,
            stashInitialSize: 2 * 1024 * 1024,  // 2MB initial buffer — enough for first few seconds
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 60,
            autoCleanupMinBackwardDuration: 30,
            liveBufferLatencyChasing: false,     // Disable — hard seeks cause jumpy playback on start
          });
          activeMpegtsPlayer = player;

          // Register all event handlers BEFORE attaching/loading
          player.on(mpegts.Events.ERROR, (type: string, detail: string, info: unknown) => {
            log.error(`mpegts ERROR: type=${type} detail=${detail}`, info);
            setError(`Live stream error: ${detail}`);
          });
          player.on(mpegts.Events.LOADING_COMPLETE, () => {
            log.info('mpegts: loading complete');
          });
          player.on(mpegts.Events.MEDIA_INFO, (info: unknown) => {
            log.info('mpegts: media info received', info);
          });
          player.on(mpegts.Events.STATISTICS_INFO, (info: unknown) => {
            log.debug('mpegts: stats', info);
          });

          try {
            player.attachMediaElement(video);
            log.info('HTML5: mpegts.js attached to video element');
            player.load();
            log.info('HTML5: mpegts.js load() called — waiting for canplay to start playback');
          } catch (e) {
            log.error('HTML5: mpegts.js attach/load/play threw', e);
            setError('Failed to start live stream');
          }
        }).catch((e) => { log.error('HTML5: failed to import mpegts.js', e); setError('Failed to load live TV player'); });
      } else {
        // VOD (MP4, etc) — direct URL (no proxy needed, browser handles it)
        log.info(`HTML5: direct video playback, setting src=${playUrl}`);
        setupEvents();
        video.src = playUrl;
        video.load();
      }
    }
  }, []);

  const stop = useCallback(() => {
    playerRef.current = null;
    setSubtitleTracks([]);
    setCurrentSubtitleIndex(-1);
    setSubtitleText('');
    stopPlayback();
  }, []);

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

  const togglePlay = useCallback(() => {
    if (typeof webapis !== 'undefined' && webapis.avplay) {
      try {
        const state = webapis.avplay.getState();
        if (state === 'PLAYING') webapis.avplay.pause();
        else if (state === 'PAUSED') webapis.avplay.play();
      } catch (err) { toast(`Toggle play failed: ${err}`); }
    } else {
      const video = document.getElementById('av-player') as HTMLVideoElement | null;
      if (video) {
        if (video.paused) {
          video.play().catch((err) => toast(`Play failed: ${err}`));
        } else {
          video.pause();
        }
      }
    }
  }, []);

  const seek = useCallback((time: number) => {
    if (typeof webapis !== 'undefined' && webapis.avplay) {
      try { webapis.avplay.seekTo(time * 1000); } catch (err) { toast(`Seek failed: ${err}`); }
    } else {
      const video = document.getElementById('av-player') as HTMLVideoElement | null;
      if (video) video.currentTime = time;
    }
  }, []);

  const getVideoElement = useCallback(() => {
    return document.getElementById('av-player') as HTMLVideoElement | null;
  }, []);

  // No auto-cleanup on unmount — video keeps playing in background.
  // Playback is only stopped by explicit stop() call (back button, Media Session, etc.)

  // Sync media session playback state with video pause/play
  useEffect(() => {
    const video = document.getElementById('av-player') as HTMLVideoElement | null;
    if (!video || !('mediaSession' in navigator)) return;

    const onPause = () => { navigator.mediaSession.playbackState = 'paused'; };
    const onPlay = () => { navigator.mediaSession.playbackState = 'playing'; };
    video.addEventListener('pause', onPause);
    video.addEventListener('play', onPlay);
    return () => {
      video.removeEventListener('pause', onPause);
      video.removeEventListener('play', onPlay);
    };
  }, []);

  return {
    play,
    stop,
    retry,
    togglePlay,
    seek,
    getVideoElement,
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
