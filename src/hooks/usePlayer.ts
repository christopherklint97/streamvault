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
import { recordingHlsPath } from '../utils/recording-transport';
import { getRecordingPlaybackUrl, getRecordingVodStatus } from '../services/recordingPlayback';
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
import { attachFiniteHls } from '../services/finiteHls';
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
let disposeFiniteHls: (() => void) | null = null;
let finiteHlsRetry = { channelId: '', position: -1, attempts: 0, at: 0 };
let finiteHlsStallTimer: ReturnType<typeof setTimeout> | null = null;
function clearFiniteHlsStallTimer() {
  if (finiteHlsStallTimer) clearTimeout(finiteHlsStallTimer);
  finiteHlsStallTimer = null;
}
let bgProgressInterval: ReturnType<typeof setInterval> | null = null;
let bgBufferTimer: ReturnType<typeof setTimeout> | null = null;
let recordingVodPoll: ReturnType<typeof setInterval> | null = null;
let html5PlaybackGeneration = 0;
let restartActiveLiveStream: (() => void) | null = null;
let activeBrowserSubtitleController: AbortController | null = null;
let activeBrowserTextTrack: TextTrack | null = null;
const browserProgrammaticTextTracks = new WeakSet<TextTrack>();
const browserSubtitleSession = new BrowserSubtitleSession();

function clearRecordingVodPoll(): void {
  if (recordingVodPoll) clearInterval(recordingVodPoll);
  recordingVodPoll = null;
}

/** Replace a rolling playlist with finite VOD without losing absolute watch time. */
function loadFiniteRecordingHls(video: HTMLVideoElement, url: string, positionSeconds: number): void {
  video.dataset.streamOffset = '0';
  const target = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0;
  video.addEventListener('loadedmetadata', () => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      toast('Seekable recording is not ready yet');
      return;
    }
    if (target > 0) {
      video.addEventListener('seeked', () => { void video.play().catch(() => {}); }, { once: true });
      video.currentTime = Math.min(target, Math.max(0, video.duration - 1));
    } else void video.play().catch(() => {});
  }, { once: true });
  video.src = url;
  video.load();
}

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

// Tizen AVPlay live-stream resilience: retry while watching, but back off
// repeated failures so a permanently-broken source cannot spin at 2s.
let avplayStallTimer: ReturnType<typeof setTimeout> | null = null;
let avplayDeferredRetryTimer: ReturnType<typeof setTimeout> | null = null;
let avplayLastRetryAt = 0;
let avplayConsecutiveFailures = 0;
let avplayRetryChannelId = '';
const AVPLAY_STALL_TIMEOUT_MS = 8000;
const AVPLAY_RETRY_COOLDOWN_MS = 2000;
const AVPLAY_HEALTHY_PROGRESS_MS = 10_000;
const AVPLAY_RETRY_DELAYS_MS = [0, 2_000, 5_000, 10_000, 20_000, 30_000];
function clearAvplayStallTimer() {
  if (avplayStallTimer) {
    clearTimeout(avplayStallTimer);
    avplayStallTimer = null;
  }
}
function clearAvplayDeferredRetryTimer() {
  if (avplayDeferredRetryTimer) {
    clearTimeout(avplayDeferredRetryTimer);
    avplayDeferredRetryTimer = null;
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
  clearFiniteHlsStallTimer();
  clearAvplayDeferredRetryTimer();
  avplayConsecutiveFailures = 0;
  avplayRetryChannelId = '';
  avplayLastRetryAt = 0;
  finiteHlsRetry = { channelId: '', position: -1, attempts: 0, at: 0 };
  clearRecordingVodPoll();
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

  disposeFiniteHls?.();
  disposeFiniteHls = null;

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

  const play = useCallback(function play(finiteRetryPosition?: number) {
    const channel = usePlayerStore.getState().currentChannel;
    if (!channel) {
      log.warn('play() called but no currentChannel set');
      return;
    }

    const setStatus = usePlayerStore.getState().setStatus;
    const setError = usePlayerStore.getState().setError;
    const audioOnly = channel.contentType === 'livetv' && usePlayerStore.getState().audioOnly;

    // Provider URLs and DVR ticket queries are credentials; never send them to client logs.
    log.info(`▶ play() channel="${channel.name}" id=${channel.id} type=${channel.contentType}`);

    // Check for saved progress to resume from
    const savedProgress = channel.contentType !== 'livetv'
      ? getWatchProgress(channel.id)
      : null;
    const resumePosition = normalizePlaybackStart(
      channel.dvrHls && Number.isFinite(finiteRetryPosition)
        ? finiteRetryPosition!
        : savedProgress ? getResumePosition(savedProgress) : (channel.initialSeekSeconds ?? 0),
    );
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
        clearAvplayDeferredRetryTimer();
        if (avplayRetryChannelId !== channel.id) {
          avplayRetryChannelId = channel.id;
          avplayConsecutiveFailures = 0;
          avplayLastRetryAt = 0;
        }
        const sessionStartedAt = Date.now();
        avplay.close();
        // Route through the server proxy for every media type. Tizen live
        // playback retains subtitle data so AVPlay can inventory real TEXT
        // tracks; setSilentSubtitle enforces the persisted Off state.
        const isRecording = Boolean(channel.recordingId);
        const playerPath = isRecording || channel.dvrHls
          ? channel.url
          : getStreamUrl(channel.id, channel.url, isLive ? true : keepSubsRef.current, isLive, audioOnly);
        const tizenPlayUrl = toAbsolutePlayerUrl(
          playerPath,
          useChannelStore.getState().apiBaseUrl
        );
        log.info(`AVPlay: opening ${channel.dvrHls ? 'finite DVR HLS' : channel.contentType} playback`);
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
        const isCurrentSession = () => playbackClock.getSnapshot().generation === clockGeneration &&
          usePlayerStore.getState().currentChannel?.id === channel.id;
        const tryAutoRetry = (reason: string) => {
          if (!isCurrentSession()) return false;
          if (isLive && avplayDeferredRetryTimer) return true; // Duplicate callback: one retry is already pending.
          const now = Date.now();
          const delay = isLive
            ? AVPLAY_RETRY_DELAYS_MS[Math.min(avplayConsecutiveFailures, AVPLAY_RETRY_DELAYS_MS.length - 1)]
            : AVPLAY_RETRY_COOLDOWN_MS;
          const remaining = Math.min(delay, Math.max(0, avplayLastRetryAt + delay - now));
          if (remaining > 0) {
            if (isLive) {
              // Keep one bounded retry pending; do not turn a terminal live EOF
              // into idle/error, or reopen a permanently failing source every 2s.
              log.warn(`AVPlay: ${reason} — deferring retry (backoff)`);
              setStatus('loading');
              avplayDeferredRetryTimer = setTimeout(() => {
                avplayDeferredRetryTimer = null;
                if (isCurrentSession()) tryAutoRetry(reason);
              }, remaining);
              return true;
            }
            log.warn(`AVPlay: ${reason} — skipping retry (cooldown)`);
            return false;
          }
          avplayLastRetryAt = now;
          if (isLive) avplayConsecutiveFailures += 1;
          log.warn(`AVPlay: ${reason} — auto-retrying`);
          clearAvplayStallTimer();
          // A finite snapshot is stable across retries. Its persisted watch
          // checkpoint is only updated every ten seconds; using it here turns
          // a segment-boundary stall into a visible replay of those seconds.
          let finiteRetryPosition: number | undefined;
          if (channel.dvrHls && startupReady) {
            try {
              const position = avplay.getCurrentTime() / 1000;
              if (Number.isFinite(position) && position > 0) finiteRetryPosition = position;
            } catch { /* fall back to the last published clock reading */ }
            if (finiteRetryPosition === undefined && playbackClock.getSnapshot().generation === clockGeneration) {
              const position = playbackClock.getSnapshot().position;
              if (position > 0) finiteRetryPosition = position;
            }
          }
          play(finiteRetryPosition);
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
            if (!isCurrentSession()) return;
            log.debug('AVPlay: buffering start');
            setStatus('loading');
            armStallWatchdog();
          },
          onbufferingcomplete: () => {
            if (!isCurrentSession()) return;
            log.debug('AVPlay: buffering complete');
            setStatus('playing');
            clearAvplayStallTimer();
          },
          oncurrentplaytime: (timeMs: number) => {
            if (!isCurrentSession()) return;
            // Progress means the stream is alive — cancel any pending watchdog.
            clearAvplayStallTimer();
            if (isLive && Number.isFinite(timeMs) && timeMs > 0 &&
                Date.now() - sessionStartedAt >= AVPLAY_HEALTHY_PROGRESS_MS) {
              avplayConsecutiveFailures = 0;
            }
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
            if (!isCurrentSession()) return;
            log.error('AVPlay: playback error');
            if (isLive && tryAutoRetry('onerror')) return;
            setError('Playback error');
          },
          onsubtitlechange: (_duration: number, text: string) => {
            if (!isCurrentSession()) return;
            tizenPlayer.emitSubtitleText(text);
          },
          onstreamcompleted: () => {
            if (!isCurrentSession()) return;
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
            if (!isCurrentSession()) return;
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
                  if (!isCurrentSession()) return;
                  log.warn('AVPlay: initial resume failed; starting from zero', error);
                  toast('Could not resume playback; playing from the beginning');
                  try {
                    await seekAvPlay(avplay, 0, 1_000);
                  } catch (resetError) {
                    log.warn('AVPlay: zero-position fallback seek failed; playing prepared media', resetError);
                  }
                }
              }
              if (!isCurrentSession()) return;
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
              if (!isCurrentSession()) return;
              log.error('AVPlay: startup failed', error);
              setError('Could not start playback');
            });
          },
          () => {
            if (!isCurrentSession()) return;
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
      clearFiniteHlsStallTimer();
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
      disposeFiniteHls?.();
      disposeFiniteHls = null;
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
      let pendingLiveEof = false;
      let eofSettled = false;
      let finiteRecoveryStarted = false;
      const recoverFiniteHls = (reason: string) => {
        if (!channel.dvrHls || !isCurrentPlayback() || finiteRecoveryStarted) return false;
        const now = Date.now();
        const clock = playbackClock.getSnapshot();
        const position = Number.isFinite(video.currentTime) && video.currentTime > 0
          ? video.currentTime : lastMediaTime > 0 ? lastMediaTime
            : clock.generation === clockGeneration && clock.position > 0 ? clock.position : resumePosition;
        if (finiteHlsRetry.channelId !== channel.id || now - finiteHlsRetry.at > 5 * 60_000 ||
            Math.abs(position - finiteHlsRetry.position) > 5) {
          finiteHlsRetry = { channelId: channel.id, position, attempts: 0, at: now };
        }
        if (finiteHlsRetry.attempts >= 2) return false;
        finiteHlsRetry.attempts += 1;
        finiteHlsRetry.position = position;
        finiteHlsRetry.at = now;
        finiteRecoveryStarted = true;
        clearFiniteHlsStallTimer();
        log.warn(`Finite HLS: ${reason} — reopening at ${position.toFixed(1)}s (attempt ${finiteHlsRetry.attempts})`);
        play(position);
        return true;
      };
      const armFiniteHlsStallTimer = (reset = false) => {
        if (!channel.dvrHls || !isCurrentPlayback() || video.paused || video.ended) return;
        if (reset) clearFiniteHlsStallTimer();
        if (finiteHlsStallTimer) return;
        finiteHlsStallTimer = setTimeout(() => {
          finiteHlsStallTimer = null;
          if (!isCurrentPlayback() || video.paused || video.ended ||
              usePlayerStore.getState().status === 'error') return;
          if (!recoverFiniteHls('no media progress')) {
            setError('Archive playback stopped making progress. Try seeking past the damaged section.');
          }
        }, 15_000);
      };
      const recoverDrainedLiveStream = (force = false) => {
        // mpegts.js emits LOADING_COMPLETE before its final MSE append settles.
        // Keep EOF pending through an intentional pause so resume can recover.
        if (!pendingLiveEof || !eofSettled || !isCurrentPlayback() ||
            liveStreamRecovery.isSuspended()) return;
        if (!force) {
          const position = video.currentTime;
          let ahead = 0;
          for (let i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= position + 0.25 && video.buffered.end(i) > position) {
              ahead = video.buffered.end(i) - position;
              break;
            }
          }
          if (ahead > 3) return;
        }
        pendingLiveEof = false;
        setStatus('loading');
        liveStreamRecovery.transportEnded('loading-complete');
      };
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
        if (!startupReady || !canPlay || playAttempted || !isCurrentPlayback() ||
            usePlayerStore.getState().status === 'error') return;
        playAttempted = true;
        log.info('HTML5: startup ready — attempting play()');
        void video.play().then(() => {
          if (!isCurrentPlayback() || usePlayerStore.getState().status === 'error') return;
          log.info('HTML5: play() succeeded');
          setStatus('playing');
        }).catch((error) => {
          if (!isCurrentPlayback() || usePlayerStore.getState().status === 'error') return;
          log.error('HTML5: play() rejected', error);
          if (isLiveTs && isCurrentPlayback()) disableLiveStreamRecovery();
          if (isCurrentPlayback()) setError('Playback blocked — tap to retry');
        });
      };
      const completeHtml5Startup = async () => {
        if (startupStarted) return;
        startupStarted = true;
        try {
          if (resumePosition > 0 && !needsBrowserTranscode && !appleMobileVodPath &&
              (!appleRecordingHlsPath || channel.recordingVodReady) &&
              (!isFiniteTsRecording || video.duration > 0)) {
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
          armFiniteHlsStallTimer();
          void completeHtml5Startup();
        };
        video.oncanplay = () => {
          canPlay = true;
          attemptPlay();
        };
        video.onseeked = () => {
          if (!channel.dvrHls || !isCurrentPlayback() || !Number.isFinite(video.currentTime)) return;
          // A backward seek resets the progress baseline; old high-water marks
          // must not make healthy playback look stalled at the new position.
          lastMediaTime = video.currentTime;
          armFiniteHlsStallTimer(true);
        };
        video.onplay = () => { recoverDrainedLiveStream(); armFiniteHlsStallTimer(); };
        video.onpause = clearFiniteHlsStallTimer;
        video.onwaiting = () => {
          if (usePlayerStore.getState().status === 'error') return;
          log.debug('HTML5 event: waiting');
          armFiniteHlsStallTimer();
          // A completed transport can still have playable MSE data. Reconnect
          // only when it is actually exhausted, not while it is buffered.
          if (pendingLiveEof) recoverDrainedLiveStream();
          // Delay showing loading spinner to avoid flashing during brief rebuffers
          if (bgBufferTimer) clearTimeout(bgBufferTimer);
          bgBufferTimer = setTimeout(() => {
            if (isCurrentPlayback() && usePlayerStore.getState().status !== 'error') setStatus('loading');
          }, 1500);
        };
        video.onplaying = () => {
          if (!isCurrentPlayback() || usePlayerStore.getState().status === 'error') return;
          log.info('HTML5 event: playing');
          if (bgBufferTimer) { clearTimeout(bgBufferTimer); bgBufferTimer = null; }
          setStatus('playing');
          setupMediaSession(channel.name);
        };
        video.ontimeupdate = () => {
          updateHtml5Clock();
          if (channel.dvrHls && isCurrentPlayback() && video.currentTime > lastMediaTime + 0.1) {
            lastMediaTime = video.currentTime;
            armFiniteHlsStallTimer(true);
          }
          if (!isLiveTs || !isCurrentPlayback() || video.currentTime <= lastMediaTime) return;
          lastMediaTime = video.currentTime;
          liveStreamRecovery.progress();
          recoverDrainedLiveStream();
        };
        video.onstalled = () => {
          if (usePlayerStore.getState().status === 'error') return;
          log.warn('HTML5 event: stalled');
          armFiniteHlsStallTimer();
          if (isLiveTs) liveStreamRecovery.stalled();
        };
        video.onsuspend = () => log.debug('HTML5 event: suspend');
        video.onerror = () => {
          if (!isCurrentPlayback()) return;
          const err = video.error;
          const errMsg = err ? `code=${err.code} message="${err.message}"` : 'unknown';
          log.error(`HTML5 event: error — ${errMsg}`);
          if (channel.dvrHls) {
            if (recoverFiniteHls('decode error')) return;
            setError('Archive playback could not recover at this position. Try seeking past the damaged section.');
            return;
          }
          if (isLiveTs && isCurrentPlayback()) {
            setStatus('loading');
            liveStreamRecovery.transportEnded('mpegts-error');
            return;
          }
          setError(`Playback failed: ${errMsg}`);
        };
        video.onabort = () => log.warn('HTML5 event: abort');
        video.onended = () => {
          if (!isCurrentPlayback() || usePlayerStore.getState().status === 'error') return;
          log.info('HTML5 event: ended');
          if (isLiveTs && isCurrentPlayback()) {
            if (pendingLiveEof) { recoverDrainedLiveStream(true); return; }
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
      const isFiniteTsRecording = isRecording && channel.recordingTransport === 'mpegts';
      const apiBaseUrl = useChannelStore.getState().apiBaseUrl;
      const appleMobileVodPath = isAppleMobile() && !channel.dvrHls
        ? iphoneVodPlaybackPath(channel.id, channel.url, channel.contentType, resumePosition)
        : null;
      const appleRecordingHlsPath = isFiniteTsRecording && isAppleMobile() && !channel.dvrHls
        ? recordingHlsPath(channel.url, channel.recordingVodReady ? 0 : resumePosition)
        : null;
      const needsBrowserTranscode = !isLiveTs && !isRecording && !channel.dvrHls && !appleMobileVodPath;
      const playUrl = channel.dvrHls
        ? channel.url
        : isRecording
          ? appleRecordingHlsPath ? `${apiBaseUrl}${appleRecordingHlsPath}` : channel.url
        : appleMobileVodPath
          ? `${apiBaseUrl}${appleMobileVodPath}`
            : needsBrowserTranscode
            ? `${apiBaseUrl}${browserTranscodePath(channel.id, channel.id.startsWith('episode_') ? channel.url : undefined, resumePosition)}`
            : getStreamUrl(channel.id, channel.url, isLiveTs ? true : keepSubsRef.current, isLiveTs, audioOnly);
      log.info(`HTML5: starting ${channel.dvrHls ? 'finite DVR HLS' : channel.contentType} playback`);

      if (isLiveTs || (isFiniteTsRecording && !appleRecordingHlsPath)) {
        // Native video cannot demux a saved MPEG-TS master either.
        log.info(`HTML5: loading mpegts.js for ${isLiveTs ? 'live' : 'recorded'} MPEG-TS playback...`);
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
            if (isLiveTs) disableLiveStreamRecovery();
            setError(isLiveTs ? 'Live TV playback not supported on this browser' : 'Recording playback not supported on this browser');
            return;
          }
          const player = mpegts.createPlayer({
            type: 'mpegts',
            isLive: isLiveTs,
            url: playUrl,
            ...(!isLiveTs && channel.duration ? { duration: channel.duration * 1000 } : {}),
            ...(!isLiveTs && channel.recordingSize ? { filesize: channel.recordingSize } : {}),
          }, {
            enableWorker: false,
            enableStashBuffer: true,
            stashInitialSize: 2 * 1024 * 1024,  // 2MB initial buffer — enough for first few seconds
            lazyLoad: !isLiveTs,
            lazyLoadMaxDuration: 25,
            lazyLoadRecoverDuration: 10,
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
            if (isLiveTs) {
              setStatus('loading');
              liveStreamRecovery.transportEnded('mpegts-error');
            } else setError(`Recording playback failed (${detail})`);
          });
          player.on(mpegts.Events.LOADING_COMPLETE, () => {
            if (!isCurrentPlayback() || activeMpegtsPlayer !== player) return;
            log.info('mpegts: loading complete');
            if (isLiveTs) {
              pendingLiveEof = true;
              eofSettled = false;
              // The final SourceBuffer update can land after LOADING_COMPLETE.
              setTimeout(() => {
                if (!isCurrentPlayback() || activeMpegtsPlayer !== player) return;
                eofSettled = true;
                recoverDrainedLiveStream();
              }, 750);
            }
          });
          player.on(mpegts.Events.MEDIA_INFO, (info: unknown) => {
            log.info('mpegts: media info received', info);
          });
          player.on(mpegts.Events.STATISTICS_INFO, (info: unknown) => {
            if (!isCurrentPlayback() || activeMpegtsPlayer !== player) return;
            log.debug('mpegts: stats', info);
            const decodedFrames = (info as { decodedFrames?: number }).decodedFrames;
            if (isLiveTs && hasDecodedFrameProgress(lastDecodedFrames, decodedFrames)) {
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
            if (isLiveTs) liveStreamRecovery.transportEnded('mpegts-error');
            else setError('Failed to start recorded MPEG-TS playback');
          }
        }).catch((e) => {
          if (!isCurrentPlayback()) return;
          log.error('HTML5: failed to import mpegts.js', e);
          if (isLiveTs) disableLiveStreamRecovery();
          setError(isLiveTs ? 'Failed to load live TV player' : 'Failed to load recording player');
        });
      } else if (channel.dvrHls) {
        setupEvents();
        const syncDvrSubtitleTracks = () => {
          if (!isCurrentPlayback()) return;
          const tracks = getHtml5SubtitleTracks(video.textTracks,
            textTrack => !browserProgrammaticTextTracks.has(textTrack));
          const selectedIndex = selectPreferredSubtitleTrack(tracks, keepSubsRef.current, getSubtitleLanguage());
          applyHtml5SubtitleSelection(video, selectedIndex);
          browserSubtitleSession.replace(channel.id, tracks, selectedIndex);
        };
        video.textTracks.onaddtrack = syncDvrSubtitleTracks;
        video.textTracks.onremovetrack = syncDvrSubtitleTracks;
        syncDvrSubtitleTracks();
        video.dataset.streamOffset = '0';
        void attachFiniteHls(video, playUrl, _detail => {
          if (isCurrentPlayback() && !recoverFiniteHls('HLS failure')) {
            log.warn('Finite HLS failed after bounded recovery');
            setError('Archive playback could not recover. Try seeking past the damaged section.');
          }
        }).then(dispose => {
          if (!isCurrentPlayback()) { dispose(); return; }
          disposeFiniteHls = dispose;
        }).catch(error => {
          if (isCurrentPlayback()) setError(error instanceof Error ? error.message : String(error));
        });
      } else {
        // VOD (MP4, etc) — direct URL (no proxy needed, browser handles it)
        log.info('HTML5: setting direct video source');
        setupEvents();
        // Force aggressive preload for VOD so the browser fills its buffer
        // before playback starts. iOS Safari may clamp this without user
        // gesture, but Chrome/Edge/Android honor it.
        try { video.preload = 'auto'; } catch { /* ignore */ }
        video.dataset.streamOffset = needsBrowserTranscode || appleMobileVodPath || (appleRecordingHlsPath && !channel.recordingVodReady)
          ? String(resumePosition) : '0';
        video.src = playUrl;
        video.load();

        if (appleRecordingHlsPath && !channel.recordingVodReady && channel.recordingId) {
          clearRecordingVodPoll();
          const recordingId = channel.recordingId;
          let checking = false;
          recordingVodPoll = setInterval(() => {
            if (checking) return;
            if (!isCurrentPlayback()) { clearRecordingVodPoll(); return; }
            checking = true;
            void (async () => {
              try {
                if (await getRecordingVodStatus(apiBaseUrl, recordingId) !== 'ready' || !isCurrentPlayback()) return;
                const freshUrl = await getRecordingPlaybackUrl({
                  apiBaseUrl, recordingId,
                  directUrl: `/api/recordings/${encodeURIComponent(recordingId)}/stream`,
                });
                if (!isCurrentPlayback()) return;
                const position = Number(video.dataset.streamOffset || 0) + video.currentTime;
                clearRecordingVodPoll();
                usePlayerStore.setState({ currentChannel: { ...channel, recordingVodReady: true } });
                loadFiniteRecordingHls(video, `${apiBaseUrl}${recordingHlsPath(freshUrl, 0)}`, position);
                toast('Full recording is ready to seek');
              } catch (error) {
                if (isCurrentPlayback()) log.warn('Seekable recording status check failed', error);
              } finally { checking = false; }
            })();
          }, 5_000);
        }

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
    const channel = usePlayerStore.getState().currentChannel;
    const video = document.getElementById('av-player') as HTMLVideoElement | null;
    const position = channel?.dvrHls && video && Number.isFinite(video.currentTime) && video.currentTime > 0
      ? video.currentTime : undefined;
    clearError();
    play(position);
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
      const appleMobileVodPath = isAppleMobile() && !channel.dvrHls
        ? iphoneVodPlaybackPath(channel.id, channel.url, channel.contentType, targetTime)
        : null;
      const usesTranscode = channel.contentType !== 'livetv' && !channel.recordingId && !channel.dvrHls && !appleMobileVodPath;
      const appleRecordingHls = !channel.dvrHls && channel.recordingTransport === 'mpegts' && isAppleMobile();
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
      if (appleRecordingHls && channel.recordingId) {
        const apiBaseUrl = useChannelStore.getState().apiBaseUrl;
        const recordingId = channel.recordingId;
        const seekGeneration = html5PlaybackGeneration;
        void (async () => {
          const status = await getRecordingVodStatus(apiBaseUrl, recordingId)
            .catch(() => channel.recordingVodReady ? 'ready' : 'missing');
          const freshUrl = await getRecordingPlaybackUrl({
            apiBaseUrl, recordingId,
            directUrl: `/api/recordings/${encodeURIComponent(recordingId)}/stream`,
          });
          if (html5PlaybackGeneration !== seekGeneration ||
              usePlayerStore.getState().currentChannel?.id !== channel.id ||
              latestManualSeekTarget !== targetTime) return;
          if (status === 'ready') {
            clearRecordingVodPoll();
            usePlayerStore.setState({ currentChannel: { ...channel, recordingVodReady: true } });
            loadFiniteRecordingHls(video, `${apiBaseUrl}${recordingHlsPath(freshUrl, 0)}`, targetTime);
          } else {
            video.dataset.streamOffset = String(targetTime);
            video.src = `${apiBaseUrl}${recordingHlsPath(freshUrl, targetTime)}`;
            video.load();
            void video.play().catch(() => {});
          }
        })().catch(error => toast(`Recording seek failed: ${error instanceof Error ? error.message : String(error)}`));
      } else if (appleMobileVodPath) {
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
        if (channel.dvrHls && usePlayerStore.getState().status === 'error') {
          usePlayerStore.getState().clearError();
          play(targetTime);
        } else video.currentTime = targetTime;
      }
    }
  }, [play]);

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
