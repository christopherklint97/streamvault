import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from 'react';
import type MpegtsType from 'mpegts.js';
import { usePlayerStore } from '../stores/playerStore';
import { useChannelStore } from '../stores/channelStore';
import type { PlayerState, Channel } from '../types';
import type { SubtitleTrack } from '../services/avplay';
import { TizenPlayer } from '../services/avplay';
import { saveWatchProgress, getWatchProgress, getSubtitlesEnabled, setSubtitlesEnabled, getSubtitleLanguage, setSubtitleLanguage } from '../services/channel-service';
import { clientLogger as log } from '../utils/logger';
import { useAppStore } from '../stores/appStore';
import { browserTranscodePath, iphoneVodPlaybackPath, normalizePlaybackStart, subtitleMetadataPath, subtitleTrackPath, toAbsolutePlayerUrl } from '../utils/stream-url';
import {
  BrowserSubtitleSession,
  applyHtml5SubtitleSelection,
  getBrowserSubtitleTiming,
  getHtml5SubtitleTracks,
  mapExtractedSubtitleCueTimes,
  selectPreferredSubtitleTrack,
} from '../utils/subtitles';
import { streamWebVttCues } from '../utils/webvtt-stream';
import { isAppleMobile } from '../utils/platform';
import { getHtml5WatchProgress, getResumePosition } from '../utils/media-progress';
import { LiveStreamRecovery } from '../utils/live-stream-recovery';
import { hasDecodedFrameProgress, withLiveStreamOptions } from '../utils/live-stream-options';
import { isCastConnected } from '../utils/cast';
import { commercialSkipSession } from '../services/commercialSkipSession';
import type { CommercialSkipSnapshot } from '../services/commercialSkipSession';
import {
  getInitialResumeTarget,
  retryPlaybackSeek,
  seekAvPlay,
  seekHtml5,
} from '../services/playbackSeek';
import { useRecordingStore } from '../stores/recordingStore';
import {
  getAvPlayClockReading,
  getHtml5ClockReading,
  playbackClock,
  routePlaybackClock,
} from '../services/playbackClock';

const toast = (msg: string) => useAppStore.getState().showToastMessage(msg);

const PROGRESS_SAVE_INTERVAL = 10_000; // Save progress every 10 seconds

let manualSeekIntentRevision = 0;
let latestManualSeekTarget: number | null = null;

function registerManualSeekIntent(target: number | null): void {
  manualSeekIntentRevision += 1;
  latestManualSeekTarget = target;
  commercialSkipSession.noteManualSeek();
}

function resetManualSeekIntent(): void {
  manualSeekIntentRevision += 1;
  latestManualSeekTarget = null;
}

export function seekRecordingPlayback(targetSeconds: number, signal?: AbortSignal): Promise<void> {
  if (typeof webapis !== 'undefined' && webapis.avplay) {
    const intentRevisionAtStart = manualSeekIntentRevision;
    const restoreLatestManualIntent = () => {
      if (manualSeekIntentRevision === intentRevisionAtStart || latestManualSeekTarget === null) return;
      try { webapis.avplay.seekTo(latestManualSeekTarget * 1000); } catch { /* the manual seek already reported errors */ }
    };
    return retryPlaybackSeek(
      () => seekAvPlay(webapis.avplay, targetSeconds, 3_000, signal, restoreLatestManualIntent),
      { signal },
    );
  }
  const video = document.getElementById('av-player') as HTMLVideoElement | null;
  if (!video) return Promise.reject(new Error('Video element not found'));
  return retryPlaybackSeek(
    () => seekHtml5(video, targetSeconds, 3_000, signal),
    { signal },
  );
}

function beginCommercialPlayback(channel: Channel): number {
  if (!channel.recordingId) return commercialSkipSession.reset();
  return commercialSkipSession.loadPlayback({
    recordingId: channel.recordingId,
    duration: channel.duration ?? 0,
    seek: seekRecordingPlayback,
    fetchMetadata: async () => {
      const metadata = await useRecordingStore.getState().fetchCommercialSegments(
        channel.recordingId!,
        { force: true, silent: true },
      );
      if (!metadata) throw new Error('Commercial metadata unavailable');
      return metadata;
    },
  });
}

// ---------------------------------------------------------------------------
// Module-level state — persists across Player mount/unmount so background
// playback keeps working even after the user navigates away.
// ---------------------------------------------------------------------------

let activeMpegtsPlayer: MpegtsType.Player | null = null;
let bgProgressInterval: ReturnType<typeof setInterval> | null = null;
let bgBufferTimer: ReturnType<typeof setTimeout> | null = null;
let html5PlaybackGeneration = 0;
let restartActiveLiveStream: (() => void) | null = null;
let activeBrowserSubtitleController: AbortController | null = null;
let activeBrowserTextTrack: TextTrack | null = null;
const browserProgrammaticTextTracks = new WeakSet<TextTrack>();
const browserSubtitleSession = new BrowserSubtitleSession();

function clearBrowserSubtitleTrack(): void {
  activeBrowserSubtitleController?.abort();
  activeBrowserSubtitleController = null;
  if (activeBrowserTextTrack) {
    activeBrowserTextTrack.mode = 'disabled';
    const cues = activeBrowserTextTrack.cues;
    if (cues) {
      while (cues.length > 0) activeBrowserTextTrack.removeCue(cues[0]);
    }
  }
  activeBrowserTextTrack = null;
}

function subtitleDirectUrl(channel: Channel): string | undefined {
  return channel.id.startsWith('episode_') ? channel.url : undefined;
}

async function fetchBrowserSubtitleTracks(channel: Channel, apiBaseUrl: string): Promise<SubtitleTrack[]> {
  const iosFallback = isAppleMobile() && channel.contentType === 'movies';
  const response = await fetch(`${apiBaseUrl}${subtitleMetadataPath(channel.id, subtitleDirectUrl(channel), iosFallback)}`, {
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Subtitle discovery failed (${response.status})`);
  const payload = await response.json() as { tracks?: unknown };
  if (!Array.isArray(payload.tracks)) return [];
  return payload.tracks.filter((track): track is SubtitleTrack => {
    if (!track || typeof track !== 'object') return false;
    const value = track as Partial<SubtitleTrack>;
    return Number.isInteger(value.index) && typeof value.language === 'string' && typeof value.label === 'string';
  });
}

function startBrowserSubtitleTrack(
  video: HTMLVideoElement,
  channel: Channel,
  track: SubtitleTrack,
  apiBaseUrl: string,
  timing = getBrowserSubtitleTiming(Number(video.dataset.streamOffset || '0'), video.currentTime),
): void {
  clearBrowserSubtitleTrack();
  const controller = new AbortController();
  const textTrack = video.addTextTrack('subtitles', track.label, track.language);
  browserProgrammaticTextTracks.add(textTrack);
  const url = `${apiBaseUrl}${subtitleTrackPath(
    channel.id,
    track.index,
    subtitleDirectUrl(channel),
    timing.extractionStart,
    isAppleMobile() && channel.contentType === 'movies',
  )}`;
  textTrack.mode = 'showing';
  activeBrowserSubtitleController = controller;
  activeBrowserTextTrack = textTrack;

  void streamWebVttCues(url, controller.signal, (cue) => {
    if (activeBrowserSubtitleController !== controller) return;
    try {
      const cueTimes = mapExtractedSubtitleCueTimes(cue.startTime, cue.endTime, timing);
      if (!cueTimes) return;
      textTrack.addCue(new VTTCue(cueTimes.startTime, cueTimes.endTime, cue.text));
    } catch (error) {
      log.warn('Subtitle cue rejected', error);
    }
  }).catch((error) => {
    if (controller.signal.aborted) return;
    log.warn('Subtitle stream failed', error);
    toast('Could not load the selected subtitles');
  });
}


const liveStreamRecovery = new LiveStreamRecovery((reason, attempt) => {
  log.warn(`Live stream: ${reason} — reconnecting (attempt ${attempt})`);
  usePlayerStore.getState().setStatus('loading');
  restartActiveLiveStream?.();
});

function disableLiveStreamRecovery() {
  restartActiveLiveStream = null;
  liveStreamRecovery.stop();
}

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

/** Save watch progress using the current video/avplay state. */
function saveProgressNow(markEnded = false) {
  const channel = usePlayerStore.getState().currentChannel;
  if (!channel || channel.contentType === 'livetv') return;
  // A natural ended event is the only completion signal available when an
  // episode has neither a finite media duration nor provider duration. Known
  // durations still use the 95% threshold, avoiding false completion on an
  // unexpectedly truncated stream.
  const completedOverride = markEnded
    && channel.contentType === 'series'
    && !(Number.isFinite(channel.duration) && (channel.duration ?? 0) > 0);

  if (typeof webapis !== 'undefined' && webapis.avplay) {
    try {
      const position = webapis.avplay.getCurrentTime() / 1000;
      const progress = getHtml5WatchProgress(
        position,
        webapis.avplay.getDuration() / 1000,
        0,
        channel.duration,
      );
      if (progress) {
        saveWatchProgress(channel.id, progress.position, progress.duration, channel.contentType, channel.seriesId, completedOverride);
      }
    } catch { /* ignore */ }
  } else {
    const video = document.getElementById('av-player') as HTMLVideoElement | null;
    if (video) {
      const progress = getHtml5WatchProgress(
        video.currentTime,
        video.duration,
        Number(video.dataset.streamOffset || '0'),
        channel.duration,
      );
      if (progress) {
        saveWatchProgress(channel.id, progress.position, progress.duration, channel.contentType, channel.seriesId, completedOverride);
      }
    }
  }
}

function startBgProgressTracking() {
  if (bgProgressInterval) clearInterval(bgProgressInterval);
  bgProgressInterval = setInterval(saveProgressNow, PROGRESS_SAVE_INTERVAL);
}

function stopBgProgressTracking() {
  if (!bgProgressInterval) return;
  clearInterval(bgProgressInterval);
  bgProgressInterval = null;
  saveProgressNow();
}

/** Set up Media Session API so the user gets notification-center controls */
function setupMediaSession(channelName: string) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({ title: channelName });
  navigator.mediaSession.playbackState = 'playing';

  const getVideo = () => document.getElementById('av-player') as HTMLVideoElement | null;

  navigator.mediaSession.setActionHandler('play', () => {
    if (usePlayerStore.getState().currentChannel?.contentType === 'livetv') {
      liveStreamRecovery.resume();
    }
    getVideo()?.play().catch(() => {});
    navigator.mediaSession.playbackState = 'playing';
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    if (usePlayerStore.getState().currentChannel?.contentType === 'livetv') {
      liveStreamRecovery.suspend();
    }
    getVideo()?.pause();
    navigator.mediaSession.playbackState = 'paused';
  });
  navigator.mediaSession.setActionHandler('stop', () => {
    stopActivePlayback();
  });
  navigator.mediaSession.setActionHandler('seekbackward', () => {
    const v = getVideo();
    if (v) {
      const target = Math.max(0, v.currentTime - 10);
      registerManualSeekIntent(target);
      v.currentTime = target;
    }
  });
  navigator.mediaSession.setActionHandler('seekforward', () => {
    const v = getVideo();
    if (v) {
      const target = Math.min(v.duration || Infinity, v.currentTime + 10);
      registerManualSeekIntent(target);
      v.currentTime = target;
    }
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
export function stopActivePlayback() {
  log.info('⏹ stopPlayback()');

  stopBgProgressTracking();
  html5PlaybackGeneration += 1;
  playbackClock.reset();
  resetManualSeekIntent();
  commercialSkipSession.reset();
  disableLiveStreamRecovery();
  clearBrowserSubtitleTrack();
  browserSubtitleSession.clear();

  if (bgBufferTimer) { clearTimeout(bgBufferTimer); bgBufferTimer = null; }

  if (activeMpegtsPlayer) {
    log.info('Destroying mpegts.js player');
    const player = activeMpegtsPlayer;
    activeMpegtsPlayer = null;
    try {
      player.destroy();
    } catch (err) {
      toast(`Player cleanup error: ${err}`);
    }
  }

  if (typeof webapis !== 'undefined' && webapis.avplay) {
    clearAvplayStallTimer();
    try {
      webapis.avplay.stop();
    } catch (err) {
      toast(`Player cleanup error: ${err}`);
    }
    try {
      webapis.avplay.close();
    } catch (err) {
      toast(`Player cleanup error: ${err}`);
    }
  } else {
    const v = document.getElementById('av-player') as HTMLVideoElement | null;
    if (v) {
      try {
        v.pause();
        v.removeAttribute('src');
        delete v.dataset.channelId;
        v.load();
      } catch (err) {
        toast(`Player cleanup error: ${err}`);
      }
    }
  }

  clearMediaSession();
  usePlayerStore.getState().setStatus('idle');
}

// ---------------------------------------------------------------------------

/**
 * Build a server-proxied stream URL for the player.
 *
 * Every platform, including Tizen AVPlay, uses the StreamVault proxy. Keeping
 * the client-facing path uniform ensures Xtream API and media traffic follows
 * the server's configured egress route (including the optional VPN namespace)
 * without exposing provider credentials or routing details to clients.
 *
 * @param directUrl the upstream URL required for episodes not stored in the DB
 */
export function getStreamUrl(channelId: string, directUrl?: string, keepSubs?: boolean, isLive?: boolean, audioOnly?: boolean): string {
  const apiBaseUrl = useChannelStore.getState().apiBaseUrl;

  const params: string[] = [];
  if (directUrl && channelId.startsWith('episode_')) {
    params.push(`url=${encodeURIComponent(directUrl)}`, 'type=series');
  }
  if (keepSubs) params.push('subs=1');
  const query = params.length ? `?${params.join('&')}` : '';
  const streamPath = `${apiBaseUrl}/api/stream/${encodeURIComponent(channelId)}${query}`;
  return withLiveStreamOptions(streamPath, Boolean(isLive && audioOnly));
}

export function usePlayer(): {
  play: () => void;
  stop: () => void;
  retry: () => void;
  togglePlay: () => void;
  beginManualSeek: () => void;
  seek: (time: number) => void;
  getVideoElement: () => HTMLVideoElement | null;
  playbackPosition: number;
  playbackDuration: number;
  commercialSkip: CommercialSkipSnapshot;
  undoCommercialSkip: () => Promise<boolean>;
  playerState: PlayerState;
  subtitleTracks: SubtitleTrack[];
  currentSubtitleIndex: number;
  subtitleText: string;
  selectSubtitleTrack: (index: number) => void;
} {
  const store = usePlayerStore();
  const clockSnapshot = useSyncExternalStore(
    playbackClock.subscribe,
    playbackClock.getSnapshot,
    playbackClock.getSnapshot,
  );
  const commercialSkip = useSyncExternalStore(
    commercialSkipSession.subscribe,
    commercialSkipSession.getSnapshot,
    commercialSkipSession.getSnapshot,
  );
  const restoredBrowserSubtitles = browserSubtitleSession.forChannel(
    usePlayerStore.getState().currentChannel?.id,
  );
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>(restoredBrowserSubtitles.tracks);
  const [currentSubtitleIndex, setCurrentSubtitleIndex] = useState(restoredBrowserSubtitles.selectedIndex);
  const [subtitleText, setSubtitleText] = useState(restoredBrowserSubtitles.text);
  const playerRef = useRef<TizenPlayer | null>(null);
  const subtitleTracksRef = useRef<SubtitleTrack[]>(restoredBrowserSubtitles.tracks);
  const selectedSubtitleIndexRef = useRef(restoredBrowserSubtitles.selectedIndex);
  // Mirrors the persisted global subtitles preference. Defaults to false;
  // browser live playback still carries captions so it can expose only tracks
  // that the media element actually detects, with Off enforced by track mode.
  const keepSubsRef = useRef(getSubtitlesEnabled());

  const play = useCallback(function play() {
    const channel = usePlayerStore.getState().currentChannel;
    if (!channel) {
      log.warn('play() called but no currentChannel set');
      return;
    }

    const setStatus = usePlayerStore.getState().setStatus;
    const setError = usePlayerStore.getState().setError;
    const audioOnly = channel.contentType === 'livetv' && usePlayerStore.getState().audioOnly;

    log.info(`▶ play() channel="${channel.name}" id=${channel.id} type=${channel.contentType} url=${channel.url ? channel.url.substring(0, 60) + '...' : '(empty)'}`);

    // Check for saved progress to resume from
    const savedProgress = channel.contentType !== 'livetv'
      ? getWatchProgress(channel.id)
      : null;
    const resumePosition = normalizePlaybackStart(getResumePosition(savedProgress));
    if (resumePosition > 0) {
      log.info(`Resuming from position ${resumePosition.toFixed(1)}s`);
    }

    setStatus('loading');
    const clockGeneration = playbackClock.begin(channel.duration ?? 0);
    const commercialGeneration = beginCommercialPlayback(channel);

    // Try AVPlay first (Samsung Tizen), fallback to HTML5 video
    if (typeof webapis !== 'undefined' && webapis.avplay) {
      browserSubtitleSession.clear();
      log.info('Using Tizen AVPlay backend');
      const isLive = channel.contentType === 'livetv';
      try {
        const avplay = webapis.avplay;
        let startupReady = false;
        clearAvplayStallTimer();
        avplay.close();
        // Route through the server proxy for every media type. Tizen live
        // playback retains subtitle data so AVPlay can inventory real TEXT
        // tracks; setSilentSubtitle enforces the persisted Off state.
        const isRecording = Boolean(channel.recordingId);
        const playerPath = isRecording
          ? channel.url
          : getStreamUrl(channel.id, channel.url, isLive ? true : keepSubsRef.current, isLive, audioOnly);
        const tizenPlayUrl = toAbsolutePlayerUrl(
          playerPath,
          useChannelStore.getState().apiBaseUrl
        );
        log.info(`AVPlay: opening ${tizenPlayUrl}`);
        avplay.open(tizenPlayUrl);
        avplay.setDisplayRect(0, 0, 1920, 1080);

        // Buffer config — live uses 10s (low latency vs. resilience tradeoff),
        // VOD uses 20s so 4K bitrates (25-50Mbps) survive ISP hiccups without
        // stalling. Tizen defaults are far too small for 4K. Catch unsupported
        // calls so older firmware doesn't break.
        const playBufferSec = isLive ? 10 : 20;
        const resumeBufferSec = isLive ? 10 : 20;
        try {
          avplay.setBufferingParam?.(
            'PLAYER_BUFFER_FOR_PLAY',
            'PLAYER_BUFFER_SIZE_IN_SECOND',
            playBufferSec
          );
          avplay.setBufferingParam?.(
            'PLAYER_BUFFER_FOR_RESUME',
            'PLAYER_BUFFER_SIZE_IN_SECOND',
            resumeBufferSec
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
          oncurrentplaytime: (timeMs: number) => {
            // Progress means the stream is alive — cancel any pending watchdog.
            clearAvplayStallTimer();
            let durationMs = 0;
            try { durationMs = avplay.getDuration(); } catch { /* unavailable while preparing */ }
            routePlaybackClock(
              playbackClock,
              clockGeneration,
              getAvPlayClockReading(timeMs, durationMs, channel.duration),
              isCastConnected() ? undefined : commercialSkipSession,
              commercialGeneration,
              startupReady,
            );
          },
          onevent: () => {},
          onerror: () => {
            log.error('AVPlay: playback error');
            if (isLive && tryAutoRetry('onerror')) return;
            setError('Playback error');
          },
          onsubtitlechange: (_duration: number, text: string) => {
            tizenPlayer.emitSubtitleText(text);
          },
          onstreamcompleted: () => {
            log.info('AVPlay: stream completed');
            // Live streams "completing" usually means the upstream dropped us — retry.
            if (isLive && tryAutoRetry('live stream completed')) return;
            stopBgProgressTracking();
            saveProgressNow(true);
            setStatus('idle');
          },
          ondrmevent: () => {},
        });
        avplay.prepareAsync(
          () => {
            log.info('AVPlay: prepared, completing initial resume');
            const completeStartup = async () => {
              if (resumePosition > 0) {
                let preparedDurationMs = 0;
                try { preparedDurationMs = avplay.getDuration(); } catch { /* duration can be unavailable */ }
                const resumeTarget = getInitialResumeTarget(
                  resumePosition,
                  preparedDurationMs / 1000,
                );
                try {
                  await retryPlaybackSeek(() => seekAvPlay(avplay, resumeTarget));
                } catch (error) {
                  if (playbackClock.getSnapshot().generation !== clockGeneration) return;
                  log.warn('AVPlay: initial resume failed; starting from zero', error);
                  toast('Could not resume playback; playing from the beginning');
                  try {
                    await seekAvPlay(avplay, 0, 1_000);
                  } catch (resetError) {
                    log.warn('AVPlay: zero-position fallback seek failed; playing prepared media', resetError);
                  }
                }
              }
              if (playbackClock.getSnapshot().generation !== clockGeneration) return;
              startupReady = true;
              let currentTimeMs = 0;
              let durationMs = 0;
              try {
                currentTimeMs = avplay.getCurrentTime();
                durationMs = avplay.getDuration();
              } catch { /* the first AVPlay clock callback will publish */ }
              routePlaybackClock(
                playbackClock,
                clockGeneration,
                getAvPlayClockReading(currentTimeMs, durationMs, channel.duration),
                isCastConnected() ? undefined : commercialSkipSession,
                commercialGeneration,
                startupReady,
              );
              avplay.play();
              setStatus('playing');
              const tracks = tizenPlayer.refreshSubtitleTracks();
              subtitleTracksRef.current = tracks;
              setSubtitleTracks(tracks);
              const selectedIndex = selectPreferredSubtitleTrack(
                tracks,
                keepSubsRef.current,
                getSubtitleLanguage(),
              );
              selectedSubtitleIndexRef.current = selectedIndex;
              setCurrentSubtitleIndex(selectedIndex);
              tizenPlayer.setSubtitleTrack(selectedIndex);
              startBgProgressTracking();
              setupMediaSession(channel.name);
            };
            void completeStartup().catch((error) => {
              log.error('AVPlay: startup failed', error);
              setError('Could not start playback');
            });
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

      const isLiveTs = channel.contentType === 'livetv';
      video.dataset.channelId = channel.id;
      const playbackGeneration = ++html5PlaybackGeneration;
      const isCurrentPlayback = () => playbackGeneration === html5PlaybackGeneration;
      if (isLiveTs) {
        restartActiveLiveStream = play;
        liveStreamRecovery.begin(channel.id);
      } else {
        restartActiveLiveStream = null;
        liveStreamRecovery.stop();
      }

      log.info(`HTML5: found video element, readyState=${video.readyState}, networkState=${video.networkState}`);

      // Clean up any previous playback state
      clearBrowserSubtitleTrack();
      video.textTracks.onaddtrack = null;
      video.textTracks.onremovetrack = null;
      browserSubtitleSession.replace(channel.id, [], -1);
      subtitleTracksRef.current = [];
      selectedSubtitleIndexRef.current = -1;
      setSubtitleTracks([]);
      setCurrentSubtitleIndex(-1);
      setSubtitleText('');
      if (activeMpegtsPlayer) {
        log.info('HTML5: destroying previous mpegts.js instance');
        const previousPlayer = activeMpegtsPlayer;
        activeMpegtsPlayer = null;
        previousPlayer.destroy();
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

      let lastMediaTime = -1;
      let startupReady = false;
      let startupStarted = false;
      let canPlay = false;
      let playAttempted = false;
      const updateHtml5Clock = () => {
        routePlaybackClock(
          playbackClock,
          clockGeneration,
          getHtml5ClockReading(
            video.currentTime,
            video.duration,
            Number(video.dataset.streamOffset || '0'),
            channel.duration,
          ),
          isCastConnected() ? undefined : commercialSkipSession,
          commercialGeneration,
          startupReady,
        );
      };
      const attemptPlay = () => {
        if (!startupReady || !canPlay || playAttempted || !isCurrentPlayback()) return;
        playAttempted = true;
        log.info('HTML5: startup ready — attempting play()');
        void video.play().then(() => {
          if (!isCurrentPlayback()) return;
          log.info('HTML5: play() succeeded');
          setStatus('playing');
        }).catch((error) => {
          log.error('HTML5: play() rejected', error);
          if (isLiveTs && isCurrentPlayback()) disableLiveStreamRecovery();
          if (isCurrentPlayback()) setError('Playback blocked — tap to retry');
        });
      };
      const completeHtml5Startup = async () => {
        if (startupStarted) return;
        startupStarted = true;
        try {
          if (resumePosition > 0 && !needsBrowserTranscode && !appleMobileVodPath) {
            const resumeTarget = getInitialResumeTarget(resumePosition, video.duration);
            await retryPlaybackSeek(() => seekHtml5(video, resumeTarget));
          }
        } catch (error) {
          if (!isCurrentPlayback()) return;
          log.warn('HTML5: initial resume failed; starting from zero', error);
          toast('Could not resume playback; playing from the beginning');
          try {
            await seekHtml5(video, 0, 1_000);
          } catch (resetError) {
            log.warn('HTML5: zero-position fallback seek failed; playing prepared media', resetError);
          }
        }
        if (!isCurrentPlayback()) return;
        startupReady = true;
        updateHtml5Clock();
        startBgProgressTracking();
        attemptPlay();
      };
      const setupEvents = () => {
        video.onloadstart = () => log.debug('HTML5 event: loadstart');
        video.onloadedmetadata = () => {
          log.info(`HTML5 event: loadedmetadata, duration=${video.duration}, videoWidth=${video.videoWidth}x${video.videoHeight}`);
        };
        video.ondurationchange = updateHtml5Clock;
        video.onloadeddata = () => {
          log.info(`HTML5 event: loadeddata, readyState=${video.readyState}`);
          void completeHtml5Startup();
        };
        video.oncanplay = () => {
          canPlay = true;
          attemptPlay();
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
        video.ontimeupdate = () => {
          updateHtml5Clock();
          if (!isLiveTs || !isCurrentPlayback() || video.currentTime <= lastMediaTime) return;
          lastMediaTime = video.currentTime;
          liveStreamRecovery.progress();
        };
        video.onstalled = () => {
          log.warn('HTML5 event: stalled');
          if (isLiveTs) liveStreamRecovery.stalled();
        };
        video.onsuspend = () => log.debug('HTML5 event: suspend');
        video.onerror = () => {
          const err = video.error;
          const errMsg = err ? `code=${err.code} message="${err.message}"` : 'unknown';
          log.error(`HTML5 event: error — ${errMsg}`);
          if (isLiveTs && isCurrentPlayback()) {
            setStatus('loading');
            liveStreamRecovery.transportEnded('mpegts-error');
            return;
          }
          setError(`Playback failed: ${errMsg}`);
        };
        video.onabort = () => log.warn('HTML5 event: abort');
        video.onended = () => {
          log.info('HTML5 event: ended');
          if (isLiveTs && isCurrentPlayback()) {
            setStatus('loading');
            liveStreamRecovery.transportEnded('media-ended');
            return;
          }
          stopBgProgressTracking();
          saveProgressNow(true);
          setStatus('idle');
          clearMediaSession();
        };
      };

      const isRecording = Boolean(channel.recordingId);
      // Recordings have a direct server URL; live/VOD go through stream proxy
      const apiBaseUrl = useChannelStore.getState().apiBaseUrl;
      const appleMobileVodPath = isAppleMobile()
        ? iphoneVodPlaybackPath(channel.id, channel.url, channel.contentType, resumePosition)
        : null;
      const needsBrowserTranscode = !isLiveTs && !isRecording && !appleMobileVodPath;
      const playUrl = isRecording
        ? channel.url
        : appleMobileVodPath
          ? `${apiBaseUrl}${appleMobileVodPath}`
            : needsBrowserTranscode
            ? `${apiBaseUrl}${browserTranscodePath(channel.id, channel.id.startsWith('episode_') ? channel.url : undefined, resumePosition)}`
            : getStreamUrl(channel.id, channel.url, isLiveTs ? true : keepSubsRef.current, isLiveTs, audioOnly);
      log.info(`HTML5: playUrl=${playUrl}, contentType=${channel.contentType}`);

      if (isLiveTs) {
        // Live TV: MPEG-TS stream — use mpegts.js to demux in browser
        log.info('HTML5: loading mpegts.js for live MPEG-TS playback...');
        setupEvents();
        const syncLiveSubtitleTracks = () => {
          if (!isCurrentPlayback()) return;
          const tracks = getHtml5SubtitleTracks(
            video.textTracks,
            (textTrack) => !browserProgrammaticTextTracks.has(textTrack),
          );
          const selectedIndex = selectPreferredSubtitleTrack(
            tracks,
            keepSubsRef.current,
            getSubtitleLanguage(),
          );
          applyHtml5SubtitleSelection(video, selectedIndex);
          browserSubtitleSession.replace(channel.id, tracks, selectedIndex);
        };
        video.textTracks.onaddtrack = syncLiveSubtitleTracks;
        video.textTracks.onremovetrack = syncLiveSubtitleTracks;
        syncLiveSubtitleTracks();
        import('mpegts.js').then(({ default: mpegts }) => {
          if (!isCurrentPlayback()) return;
          log.info(`HTML5: mpegts.js loaded, isSupported=${mpegts.isSupported()}`);
          if (!mpegts.isSupported()) {
            log.error('HTML5: mpegts.js not supported');
            disableLiveStreamRecovery();
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
          let lastDecodedFrames = 0;

          // Register all event handlers BEFORE attaching/loading
          player.on(mpegts.Events.ERROR, (type: string, detail: string, info: unknown) => {
            if (!isCurrentPlayback() || activeMpegtsPlayer !== player) return;
            log.error(`mpegts ERROR: type=${type} detail=${detail}`, info);
            setStatus('loading');
            liveStreamRecovery.transportEnded('mpegts-error');
          });
          player.on(mpegts.Events.LOADING_COMPLETE, () => {
            if (!isCurrentPlayback() || activeMpegtsPlayer !== player) return;
            log.info('mpegts: loading complete');
            setStatus('loading');
            liveStreamRecovery.transportEnded('loading-complete');
          });
          player.on(mpegts.Events.MEDIA_INFO, (info: unknown) => {
            log.info('mpegts: media info received', info);
          });
          player.on(mpegts.Events.STATISTICS_INFO, (info: unknown) => {
            if (!isCurrentPlayback() || activeMpegtsPlayer !== player) return;
            log.debug('mpegts: stats', info);
            const decodedFrames = (info as { decodedFrames?: number }).decodedFrames;
            if (hasDecodedFrameProgress(lastDecodedFrames, decodedFrames)) {
              lastDecodedFrames = decodedFrames;
              liveStreamRecovery.progress();
            }
          });

          try {
            player.attachMediaElement(video);
            log.info('HTML5: mpegts.js attached to video element');
            player.load();
            log.info('HTML5: mpegts.js load() called — waiting for canplay to start playback');
          } catch (e) {
            log.error('HTML5: mpegts.js attach/load/play threw', e);
            liveStreamRecovery.transportEnded('mpegts-error');
          }
        }).catch((e) => {
          if (!isCurrentPlayback()) return;
          log.error('HTML5: failed to import mpegts.js', e);
          disableLiveStreamRecovery();
          setError('Failed to load live TV player');
        });
      } else {
        // VOD (MP4, etc) — direct URL (no proxy needed, browser handles it)
        log.info(`HTML5: direct video playback, setting src=${playUrl}`);
        setupEvents();
        // Force aggressive preload for VOD so the browser fills its buffer
        // before playback starts. iOS Safari may clamp this without user
        // gesture, but Chrome/Edge/Android honor it.
        try { video.preload = 'auto'; } catch { /* ignore */ }
        video.dataset.streamOffset = needsBrowserTranscode || appleMobileVodPath ? String(resumePosition) : '0';
        video.src = playUrl;
        video.load();

        if (!isRecording) {
          void fetchBrowserSubtitleTracks(channel, apiBaseUrl).then((tracks) => {
            if (!isCurrentPlayback()) return;
            const selectedIndex = selectPreferredSubtitleTrack(
              tracks,
              keepSubsRef.current,
              getSubtitleLanguage(),
            );
            const selectedTrack = tracks.find((track) => track.index === selectedIndex);
            if (selectedTrack) startBrowserSubtitleTrack(video, channel, selectedTrack, apiBaseUrl);
            browserSubtitleSession.replace(channel.id, tracks, selectedIndex);
          }).catch((error) => {
            if (isCurrentPlayback()) log.warn('Subtitle discovery failed', error);
          });
        }
      }
    }
  }, []);

  const stop = useCallback(() => {
    playerRef.current = null;
    subtitleTracksRef.current = [];
    selectedSubtitleIndexRef.current = -1;
    setSubtitleTracks([]);
    setCurrentSubtitleIndex(-1);
    setSubtitleText('');
    stopActivePlayback();
  }, []);

  const retry = useCallback(() => {
    log.info('🔄 retry() called');
    const clearError = usePlayerStore.getState().clearError;
    clearError();
    play();
  }, [play]);

  const selectSubtitleTrack = useCallback((index: number) => {
    const channel = usePlayerStore.getState().currentChannel;
    if (!channel) return;
    const track = subtitleTracksRef.current.find((candidate) => candidate.index === index);
    if (index !== -1 && !track) return;

    const enabled = index !== -1;
    keepSubsRef.current = enabled;
    selectedSubtitleIndexRef.current = index;
    setSubtitlesEnabled(enabled);
    if (track) setSubtitleLanguage(track.language);
    setCurrentSubtitleIndex(index);
    setSubtitleText('');

    const isLive = channel.contentType === 'livetv';
    if (typeof webapis !== 'undefined' && webapis.avplay) {
      playerRef.current?.setSubtitleTrack(index);
      return;
    }

    browserSubtitleSession.select(channel.id, index);
    const video = document.getElementById('av-player') as HTMLVideoElement | null;
    if (isLive) {
      if (video) applyHtml5SubtitleSelection(video, index);
      return;
    }
    if (!track) {
      clearBrowserSubtitleTrack();
      return;
    }
    if (video) {
      startBrowserSubtitleTrack(video, channel, track, useChannelStore.getState().apiBaseUrl);
    }
  }, []);

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
        const isLive = usePlayerStore.getState().currentChannel?.contentType === 'livetv';
        if (video.paused) {
          if (isLive) liveStreamRecovery.resume();
          video.play().catch((err) => toast(`Play failed: ${err}`));
        } else {
          if (isLive) liveStreamRecovery.suspend();
          video.pause();
        }
      }
    }
  }, []);

  const beginManualSeek = useCallback(() => {
    registerManualSeekIntent(null);
  }, []);

  const seek = useCallback((time: number) => {
    const targetTime = normalizePlaybackStart(time);
    registerManualSeekIntent(targetTime);
    if (typeof webapis !== 'undefined' && webapis.avplay) {
      try { webapis.avplay.seekTo(targetTime * 1000); } catch (err) { toast(`Seek failed: ${err}`); }
    } else {
      const video = document.getElementById('av-player') as HTMLVideoElement | null;
      const channel = usePlayerStore.getState().currentChannel;
      if (!video || !channel) return;
      const appleMobileVodPath = isAppleMobile()
        ? iphoneVodPlaybackPath(channel.id, channel.url, channel.contentType, targetTime)
        : null;
      const usesTranscode = channel.contentType !== 'livetv' && !channel.id.startsWith('recording_') && !appleMobileVodPath;
      const restartSelectedSubtitles = () => {
        const track = subtitleTracksRef.current.find(
          (candidate) => candidate.index === selectedSubtitleIndexRef.current,
        );
        if (track) {
          startBrowserSubtitleTrack(
            video,
            channel,
            track,
            useChannelStore.getState().apiBaseUrl,
            getBrowserSubtitleTiming(targetTime, 0),
          );
        }
      };
      if (appleMobileVodPath) {
        const apiBaseUrl = useChannelStore.getState().apiBaseUrl;
        video.dataset.streamOffset = String(targetTime);
        video.src = `${apiBaseUrl}${appleMobileVodPath}`;
        video.load();
        restartSelectedSubtitles();
        video.play().catch(() => {});
      } else if (usesTranscode) {
        const apiBaseUrl = useChannelStore.getState().apiBaseUrl;
        video.dataset.streamOffset = String(targetTime);
        video.src = `${apiBaseUrl}${browserTranscodePath(channel.id, channel.id.startsWith('episode_') ? channel.url : undefined, targetTime)}`;
        video.load();
        restartSelectedSubtitles();
        video.play().catch(() => {});
      } else {
        video.currentTime = targetTime;
      }
    }
  }, []);

  const getVideoElement = useCallback(() => {
    return document.getElementById('av-player') as HTMLVideoElement | null;
  }, []);

  const undoCommercialSkip = useCallback(() => commercialSkipSession.undo(), []);

  // No auto-cleanup on unmount — video keeps playing in background.
  // Playback is only stopped by explicit stop() call (back button, Media Session, etc.)

  useEffect(() => {
    const syncBrowserSubtitleSession = () => {
      const snapshot = browserSubtitleSession.forChannel(
        usePlayerStore.getState().currentChannel?.id,
      );
      subtitleTracksRef.current = snapshot.tracks;
      selectedSubtitleIndexRef.current = snapshot.selectedIndex;
      setSubtitleTracks(snapshot.tracks);
      setCurrentSubtitleIndex(snapshot.selectedIndex);
      setSubtitleText(snapshot.text);
    };
    const unsubscribe = browserSubtitleSession.subscribe(syncBrowserSubtitleSession);
    syncBrowserSubtitleSession();
    return unsubscribe;
  }, []);

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
    beginManualSeek,
    seek,
    getVideoElement,
    playbackPosition: clockSnapshot.position,
    playbackDuration: clockSnapshot.duration,
    commercialSkip,
    undoCommercialSkip,
    playerState: {
      status: store.status,
      currentChannel: store.currentChannel,
      errorMessage: store.errorMessage,
    },
    subtitleTracks,
    currentSubtitleIndex,
    subtitleText,
    selectSubtitleTrack,
  };
}
